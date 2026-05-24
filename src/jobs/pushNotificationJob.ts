import { logger } from '../utils/logger';
import {
  invalidatePushToken,
  loadActiveDevicesForUser,
  type ActiveDeviceForPush
} from '../modules/devices/device.service';
import type { PushNotificationJobPayload } from '../modules/notifications/notification.types';

/**
 * Push fan-out worker (placeholder transport).
 *
 * The notification service enqueues a job that carries only IDs and the
 * already-privacy-filtered preview text — never the full message body, never
 * raw tokens, never private metadata. The worker:
 *
 *   1. Loads the recipient's active devices from MongoDB (fresh — never
 *      trusts cached state from the producer).
 *   2. Dispatches one delivery attempt per device.
 *   3. Removes any device whose token the upstream provider reports as
 *      permanently invalid (account swap, app uninstall, expired token).
 *
 * The transport itself is still a placeholder: in production this is where
 * APNs / FCM / Web Push clients live. For now `deliver` is a structured-log
 * stand-in that DELIBERATELY does not log the push token; logging tokens
 * would defeat the `select: false` discipline on the device model.
 */
export const enqueuePushNotification = (
  payload: PushNotificationJobPayload
): void => {
  // Fire-and-forget. Failure inside the worker must never bubble back to the
  // request path that produced the inbox row — the inbox is already
  // committed and a push failure is not a user-visible error.
  void runPushFanOut(payload).catch((err) => {
    logger.error(
      {
        err,
        job: 'push-notification',
        // No tokens, no body — only enough metadata to correlate with the
        // notification row and conversation.
        userId: payload.userId,
        notificationId: payload.notificationId,
        type: payload.type
      },
      'push fan-out failed'
    );
  });
};

interface DeliveryOutcome {
  // True if the transport accepted the token. False with `tokenInvalid: true`
  // means we should drop the device row. Other false outcomes (network blip,
  // throttle) leave the row alone so the next push can retry.
  delivered: boolean;
  tokenInvalid: boolean;
}

// Per-device delivery placeholder. The real implementation dispatches via
// `device.pushProvider` to the matching transport client. We DO NOT log
// `device.pushToken` — the token is a secret and the only authorized
// consumer is the upstream provider's client library.
const deliver = async (
  device: ActiveDeviceForPush,
  payload: PushNotificationJobPayload
): Promise<DeliveryOutcome> => {
  logger.debug(
    {
      job: 'push-notification',
      userId: payload.userId,
      notificationId: payload.notificationId,
      type: payload.type,
      conversationId: payload.conversationId,
      deviceId: device.id,
      platform: device.platform,
      pushProvider: device.pushProvider,
      // Whether the preview was carried, not the preview itself. Logging the
      // preview would leak it to anyone with log access — defeating
      // messagePreviewEnabled.
      hasPreview: Boolean(payload.bodyPreview)
    },
    'push:deliver'
  );
  return { delivered: true, tokenInvalid: false };
};

const runPushFanOut = async (
  payload: PushNotificationJobPayload
): Promise<void> => {
  // Re-read the recipient's devices at fan-out time so a logout/registration
  // that landed between enqueue and now is honored. The producer is allowed
  // to be stale; the worker must not be.
  const devices = await loadActiveDevicesForUser(payload.userId);
  if (devices.length === 0) {
    // No devices — nothing to do. The inbox row is already written so the
    // user will see it next time they open the app.
    return;
  }

  for (const device of devices) {
    const outcome = await deliver(device, payload).catch(
      (err): DeliveryOutcome => {
        logger.warn(
          {
            err,
            job: 'push-notification',
            userId: payload.userId,
            deviceId: device.id
          },
          'push:deliver_failed'
        );
        return { delivered: false, tokenInvalid: false };
      }
    );

    if (outcome.tokenInvalid) {
      // Drop the device row so a re-registered token can take its place.
      // Idempotent — no-op if already removed.
      await invalidatePushToken(device.pushToken).catch((err) => {
        logger.warn(
          {
            err,
            job: 'push-notification',
            deviceId: device.id
          },
          'push:invalidate_failed'
        );
      });
    }
  }
};
