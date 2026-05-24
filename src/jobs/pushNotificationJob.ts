import { logger } from '../utils/logger';
import type { PushNotificationJobPayload } from '../modules/notifications/notification.types';

/**
 * Placeholder push-notification fan-out.
 *
 * A real implementation will plug into APNs/FCM/Web Push via a worker that
 * consumes a Redis queue. For now this is a single function the notification
 * service calls inline — it emits a structured log entry so the integration
 * point is visible in observability dashboards, and the queue swap is a
 * single-file change later.
 *
 * The payload is intentionally minimal:
 *   - never carries the full message body
 *   - obeys the user's `messagePreviewEnabled` preference (the caller decides)
 *   - never contains the recipient's auth state, tokens, or private metadata
 */
export const enqueuePushNotification = (
  payload: PushNotificationJobPayload
): void => {
  logger.debug(
    {
      job: 'push-notification',
      userId: payload.userId,
      notificationId: payload.notificationId,
      type: payload.type,
      // The preview is bounded in the model layer; we still log it so a
      // future devops dashboard can see what was sent. If the user disabled
      // previews the caller passes `bodyPreview: undefined`.
      hasPreview: Boolean(payload.bodyPreview),
      conversationId: payload.conversationId
    },
    'queue:push'
  );
};
