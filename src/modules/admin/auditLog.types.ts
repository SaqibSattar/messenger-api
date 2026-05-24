export const AUDIT_TARGET_TYPE = {
  USER: 'user',
  CONVERSATION: 'conversation',
  MESSAGE: 'message',
  ATTACHMENT: 'attachment',
  STORY: 'story',
  REPORT: 'report',
  MODERATION_ACTION: 'moderation_action',
  SESSION: 'session',
  SYSTEM: 'system'
} as const;

export type AuditTargetType =
  (typeof AUDIT_TARGET_TYPE)[keyof typeof AUDIT_TARGET_TYPE];

export const AUDIT_TARGET_TYPES = Object.values(
  AUDIT_TARGET_TYPE
) as readonly AuditTargetType[];

// The canonical set of audit actions emitted by services. Centralised here so
// admin tooling, filters, and tests can reference a single source of truth.
export const AUDIT_ACTION = {
  USER_ROLE_CHANGE: 'user.role.change',
  USER_PERMISSIONS_CHANGE: 'user.permissions.change',
  USER_LOGIN_FAILED: 'user.login.failed',
  USER_PASSWORD_CHANGED: 'user.password.changed',
  SESSION_REVOKED_ALL: 'session.revoked_all',
  CONVERSATION_DISAPPEARING_MESSAGES_CHANGE:
    'conversation.disappearing_messages.change',
  MESSAGE_EXPIRED_NOW: 'message.expired_now',
  STORY_REMOVED: 'story.removed',
  STORY_REPORTED: 'story.reported',
  REPORT_CREATED: 'report.created',
  REPORT_STATUS_CHANGED: 'report.status_changed',
  MODERATION_ACTION: 'moderation.action'
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export interface AuditLogDto {
  id: string;
  actorId?: string;
  action: string;
  targetType?: AuditTargetType;
  targetId?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export const AUDIT_LIST_DEFAULT_LIMIT = 25;
export const AUDIT_LIST_MAX_LIMIT = 100;
