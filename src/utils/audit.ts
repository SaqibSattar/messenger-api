import { logger } from './logger';
import type {
  Permission,
  Role
} from '../modules/permissions/permissions.constants';

/**
 * Security-sensitive event audit trail.
 *
 * The persistent `audit_logs` collection lands with the moderation / admin
 * observability module (10-admin-observability-audit.md). Until then these
 * helpers only emit structured logs — but every call site exists at the right
 * boundary, so swapping the implementation to also write a document is a
 * single-file change.
 */

export interface AuditContext {
  actorId: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface RoleChangeEvent {
  targetUserId: string;
  previousRole: Role;
  newRole: Role;
  reason?: string;
}

export interface PermissionChangeEvent {
  targetUserId: string;
  added: Permission[];
  removed: Permission[];
  reason?: string;
}

export interface DisappearingMessagesChangeEvent {
  conversationId: string;
  conversationType: 'direct' | 'group';
  previousDuration: string;
  newDuration: string;
}

export interface MessageExpiredNowEvent {
  conversationId: string;
  messageId: string;
  reason: 'owner' | 'moderator';
}

export interface StoryRemovedEvent {
  storyId: string;
  authorId: string;
  removedBy: 'owner' | 'moderator';
}

export interface StoryReportedEvent {
  storyId: string;
  authorId: string;
  reason: string;
  // `hasDetails` only — never log the report body itself. The reviewer in the
  // moderation module sees the full text via the persistent report record.
  hasDetails: boolean;
}

export interface ReportCreatedEvent {
  reportId: string;
  targetType: 'user' | 'message' | 'conversation';
  targetId: string;
  reason: string;
  // Body never goes to the log — only the fact one was attached.
  hasDetails: boolean;
}

export interface ReportStatusChangedEvent {
  reportId: string;
  previousStatus: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  newStatus: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  targetType: 'user' | 'message' | 'conversation';
  targetId: string;
  hasNote: boolean;
}

export interface ModerationActionEvent {
  actionId: string;
  actionType: string;
  targetType: 'user' | 'message' | 'conversation' | 'story';
  targetId: string;
  relatedReportId?: string;
  hasReason: boolean;
  hasMetadata: boolean;
}

const auditEvent = (
  event: string,
  ctx: AuditContext,
  details: Record<string, unknown>
): void => {
  logger.info(
    {
      audit: true,
      event,
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      ...details
    },
    `audit:${event}`
  );
};

export const auditRoleChange = (
  ctx: AuditContext,
  event: RoleChangeEvent
): void => {
  auditEvent('user.role.change', ctx, { ...event });
};

export const auditPermissionChange = (
  ctx: AuditContext,
  event: PermissionChangeEvent
): void => {
  auditEvent('user.permissions.change', ctx, { ...event });
};

export const auditDisappearingMessagesChange = (
  ctx: AuditContext,
  event: DisappearingMessagesChangeEvent
): void => {
  auditEvent('conversation.disappearing_messages.change', ctx, { ...event });
};

export const auditMessageExpiredNow = (
  ctx: AuditContext,
  event: MessageExpiredNowEvent
): void => {
  auditEvent('message.expired_now', ctx, { ...event });
};

export const auditStoryRemoved = (
  ctx: AuditContext,
  event: StoryRemovedEvent
): void => {
  auditEvent('story.removed', ctx, { ...event });
};

export const auditStoryReported = (
  ctx: AuditContext,
  event: StoryReportedEvent
): void => {
  auditEvent('story.reported', ctx, { ...event });
};

export const auditReportCreated = (
  ctx: AuditContext,
  event: ReportCreatedEvent
): void => {
  auditEvent('report.created', ctx, { ...event });
};

export const auditReportStatusChanged = (
  ctx: AuditContext,
  event: ReportStatusChangedEvent
): void => {
  auditEvent('report.status_changed', ctx, { ...event });
};

export const auditModerationAction = (
  ctx: AuditContext,
  event: ModerationActionEvent
): void => {
  auditEvent('moderation.action', ctx, { ...event });
};
