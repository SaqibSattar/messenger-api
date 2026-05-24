// Device registry types. A "device" is one client install owned by a user —
// the row stores just enough metadata to route push notifications and to let
// the user revoke a single client without a full logout.
//
// The push-notification transport itself is wired in prompt 14; this module
// only provides the persistence layer so the data model is in place and the
// indexes/uniqueness rules are tested.

export const DEVICE_PLATFORM = {
  IOS: 'ios',
  ANDROID: 'android',
  WEB: 'web'
} as const;

export type DevicePlatform =
  (typeof DEVICE_PLATFORM)[keyof typeof DEVICE_PLATFORM];

export const DEVICE_PLATFORMS: readonly DevicePlatform[] =
  Object.values(DEVICE_PLATFORM);

// Caps on free-text fields. Push tokens from APNs/FCM/WebPush are well under
// 1 KB in practice; the limits exist to stop a malicious client from
// inflating a row to something that would blow up an index entry.
export const DEVICE_PUSH_TOKEN_MAX_LENGTH = 2048;
export const DEVICE_DEVICE_NAME_MAX_LENGTH = 120;
export const DEVICE_APP_VERSION_MAX_LENGTH = 32;
export const DEVICE_LOCALE_MAX_LENGTH = 16;

export interface DeviceDto {
  id: string;
  userId: string;
  platform: DevicePlatform;
  // Display label shown in "your devices" lists. Server-trimmed; safe to
  // render as text but never as HTML.
  deviceName?: string;
  appVersion?: string;
  locale?: string;
  lastSeenAt: string;
  createdAt: string;
  // pushToken is intentionally NOT in the DTO — exposing it would let any
  // caller who can read the device list also send push notifications to
  // that device through the upstream provider. The token stays server-side.
}
