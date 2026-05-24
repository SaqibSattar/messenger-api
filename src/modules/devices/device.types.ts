// Device registry types. A "device" is one client install owned by a user —
// the row stores just enough metadata to route push notifications and to let
// the user revoke a single client without a full logout.
//
// The push token itself is a privileged secret. We persist the raw token
// (under `select: false`) so the push worker can read it back, but it is
// never returned in any DTO and never logged. Token uniqueness across the
// collection prevents the same physical device from being registered to two
// users (which would mis-route push fan-out after an account swap).

export const DEVICE_PLATFORM = {
  IOS: 'ios',
  ANDROID: 'android',
  WEB: 'web'
} as const;

export type DevicePlatform =
  (typeof DEVICE_PLATFORM)[keyof typeof DEVICE_PLATFORM];

export const DEVICE_PLATFORMS: readonly DevicePlatform[] =
  Object.values(DEVICE_PLATFORM);

// Provider-vendor of the push token. The worker uses this to dispatch to the
// right transport; clients send it explicitly so a web push token can't
// accidentally be queued onto APNs.
export const DEVICE_PUSH_PROVIDER = {
  APNS: 'apns',
  FCM: 'fcm',
  WEB_PUSH: 'web_push'
} as const;

export type DevicePushProvider =
  (typeof DEVICE_PUSH_PROVIDER)[keyof typeof DEVICE_PUSH_PROVIDER];

export const DEVICE_PUSH_PROVIDERS: readonly DevicePushProvider[] =
  Object.values(DEVICE_PUSH_PROVIDER);

// Caps on free-text fields. Push tokens from APNs/FCM/WebPush are well under
// 1 KB in practice; the limits exist to stop a malicious client from
// inflating a row to something that would blow up an index entry.
export const DEVICE_PUSH_TOKEN_MAX_LENGTH = 2048;
export const DEVICE_DEVICE_NAME_MAX_LENGTH = 120;
export const DEVICE_APP_VERSION_MAX_LENGTH = 32;
export const DEVICE_LOCALE_MAX_LENGTH = 16;

// A device that has not checked in for this long is considered stale and is
// dropped by the cleanup job. 90 days mirrors what APNs/FCM typically
// guarantee for token validity, so older rows are likely to fail at the
// upstream provider anyway.
export const DEVICE_STALE_AFTER_DAYS = 90;

export const LIST_DEVICES_DEFAULT_LIMIT = 25;
export const LIST_DEVICES_MAX_LIMIT = 100;

export interface DeviceDto {
  id: string;
  userId: string;
  platform: DevicePlatform;
  pushProvider: DevicePushProvider;
  // Display label shown in "your devices" lists. Server-trimmed; safe to
  // render as text but never as HTML.
  deviceName?: string;
  appVersion?: string;
  locale?: string;
  lastSeenAt: string;
  revokedAt?: string;
  createdAt: string;
  // pushToken is intentionally NOT in the DTO — exposing it would let any
  // caller who can read the device list also send push notifications to
  // that device through the upstream provider. The token stays server-side.
}
