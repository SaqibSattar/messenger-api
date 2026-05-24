// Notification system types. The shape is intentionally narrow:
// notifications carry just enough metadata for a client to render an inbox
// row and link back to the entity that triggered it. Sensitive content
// (full message bodies, report details) is NEVER stored on the notification
// itself — clients re-fetch the entity if/when they have permission to.

export const NOTIFICATION_TYPE = {
  // A new message arrived in a conversation the user belongs to.
  MESSAGE_RECEIVED: 'message_received',
  // The user was @mentioned in a message (reserved for future use).
  MESSAGE_MENTION: 'message_mention',
  // A reaction was added to one of the user's own messages.
  MESSAGE_REACTION: 'message_reaction',
  // The user was added to a group conversation.
  CONVERSATION_INVITE: 'conversation_invite',
  // A report submitted by the user changed status.
  REPORT_STATUS_CHANGED: 'report_status_changed',
  // A moderation action was applied against the user (warn/suspend/etc).
  MODERATION_ACTION: 'moderation_action'
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

export const NOTIFICATION_TYPES: readonly NotificationType[] =
  Object.values(NOTIFICATION_TYPE);

export const NOTIFICATION_ENTITY_TYPE = {
  MESSAGE: 'message',
  CONVERSATION: 'conversation',
  REPORT: 'report',
  MODERATION_ACTION: 'moderation_action',
  USER: 'user'
} as const;

export type NotificationEntityType =
  (typeof NOTIFICATION_ENTITY_TYPE)[keyof typeof NOTIFICATION_ENTITY_TYPE];

export const NOTIFICATION_ENTITY_TYPES: readonly NotificationEntityType[] =
  Object.values(NOTIFICATION_ENTITY_TYPE);

// Bounds on the rendered preview. Even when the user opts in to message
// previews, we never store more than this on the notification — the full
// body lives only on the message document. 200 mirrors the conversation
// lastMessage.preview cap, so an inbox row never carries more text than a
// conversation list row.
export const NOTIFICATION_TITLE_MAX_LENGTH = 200;
export const NOTIFICATION_BODY_PREVIEW_MAX_LENGTH = 200;

// Cursor pagination caps. Match the messages module — clients have a single
// mental model for "load more".
export const LIST_NOTIFICATIONS_DEFAULT_LIMIT = 25;
export const LIST_NOTIFICATIONS_MAX_LIMIT = 100;

export interface NotificationDto {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  bodyPreview?: string;
  entityType?: NotificationEntityType;
  entityId?: string;
  // Conversation context the entity lives inside. Surfaced so a client can
  // group messages-by-conversation without re-fetching each message.
  conversationId?: string;
  // Free-form metadata (e.g. `{ senderId, reaction }`). Always shallow,
  // always JSON-safe, never contains private message bodies.
  data?: Record<string, unknown>;
  readAt?: string;
  createdAt: string;
}

export interface ListNotificationsResult {
  items: NotificationDto[];
  nextCursor: string | null;
  // Inbox badge count — number of unread notifications for the caller across
  // ALL pages, not just this page. Capped at 99+ in the client by convention.
  unreadCount: number;
}

// Quiet hours are stored as wall-clock minutes-from-midnight in the user's
// own local timezone. The worker computes "is the recipient inside their
// quiet window right now" against an IANA zone name supplied by the client.
// We keep the timezone on the preference (not on the user) so a user with
// multiple devices in different timezones can pick the one that owns push.
export interface QuietHoursDto {
  startMinute: number;
  endMinute: number;
  timezone: string;
}

export const QUIET_HOURS_MINUTES_PER_DAY = 24 * 60;
// IANA zone names are at most 60 chars in practice; a hard cap stops a
// hostile client from stuffing the document with megabytes of garbage.
export const QUIET_HOURS_TIMEZONE_MAX_LENGTH = 64;

export interface NotificationPreferencesDto {
  // Master kill-switch for any push fan-out. When false the worker should
  // skip the user entirely.
  pushEnabled: boolean;
  // Master kill-switch for outbound emails (no email transport ships in this
  // module — the flag is honored by future email jobs).
  emailEnabled: boolean;
  // When false the push/email payload must NOT include the message body or
  // any other free-text preview — only generic copy like "New message".
  messagePreviewEnabled: boolean;
  // Whether the client should play a sound for incoming push. Server-side
  // we just relay the flag; the client owns the actual sound asset.
  soundEnabled: boolean;
  // Whether the client should vibrate. Same relay-only semantics.
  vibrationEnabled: boolean;
  // Optional quiet-hours window. When set and the recipient is inside the
  // window, push fan-out is suppressed (inbox rows still write).
  quietHours?: QuietHoursDto;
  // Conversation IDs the user has globally muted (push-only — inbox rows
  // are still written so the user can scroll back). Kept for backward
  // compatibility alongside the richer per-conversation preference rows.
  mutedConversationIds: string[];
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesDto = {
  pushEnabled: true,
  emailEnabled: false,
  messagePreviewEnabled: true,
  soundEnabled: true,
  vibrationEnabled: true,
  mutedConversationIds: []
};

export interface ConversationNotificationPreferenceDto {
  conversationId: string;
  // ISO datetime. Absent or in the past means "not muted".
  mutedUntil?: string;
  mentionOnly: boolean;
}

// Internal shape used when a service emits a notification. Callers always
// pass IDs as strings; the model converts to ObjectId on write.
export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  bodyPreview?: string;
  entityType?: NotificationEntityType;
  entityId?: string;
  conversationId?: string;
  data?: Record<string, unknown>;
}

// Payload sent to the (placeholder) push worker. Mirrors the notification
// but is intentionally separable — push payloads obey messagePreviewEnabled,
// while the inbox row always carries whatever the writer passed.
export interface PushNotificationJobPayload {
  userId: string;
  notificationId: string;
  type: NotificationType;
  title: string;
  bodyPreview?: string;
  conversationId?: string;
}
