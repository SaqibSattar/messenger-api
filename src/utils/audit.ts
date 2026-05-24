import { logger } from './logger';
import {
  AUDIT_ACTION,
  AUDIT_TARGET_TYPE,
  type AuditTargetType
} from '../modules/admin/auditLog.types';
import { persistAuditLog } from '../modules/admin/auditLog.service';
import type {
  Permission,
  Role
} from '../modules/permissions/permissions.constants';

/**
 * Security-sensitive event audit trail.
 *
 * Each typed wrapper emits both a structured log line (for live ops visibility
 * via the standard log pipeline) AND a persisted `audit_logs` document (for
 * admin-facing review). Persistence is best-effort: failures are logged but
 * never thrown, so an audit problem can never break the audited action.
 *
 * Callers should await these helpers so that the audit row is persisted
 * before the action returns its response — that keeps test assertions and
 * admin tooling consistent without paying real latency (Mongo inserts are
 * tiny).
 */

export interface AuditContext {
  actorId?: string;
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

export interface LoginFailedEvent {
  identifierType: 'email' | 'phone';
  // We never store the password attempt. The identifier is recorded only as
  // hashed length / first-char hint, not the raw value, so an audit search by
  // identifier still needs the original — but the audit row alone cannot leak
  // every attempted email/phone.
  identifierHint: string;
}

export interface PasswordChangedEvent {
  userId: string;
  sessionsRevoked: boolean;
}

export interface SessionRevokedAllEvent {
  userId: string;
  revokedCount: number;
}

const emitAudit = async (
  action: string,
  ctx: AuditContext,
  options: {
    targetType?: AuditTargetType;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> => {
  logger.info(
    {
      audit: true,
      action,
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      targetType: options.targetType,
      targetId: options.targetId,
      ...(options.metadata ?? {})
    },
    `audit:${action}`
  );
  await persistAuditLog({
    action,
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    targetType: options.targetType,
    targetId: options.targetId,
    metadata: options.metadata
  });
};

export const auditRoleChange = async (
  ctx: AuditContext,
  event: RoleChangeEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.USER_ROLE_CHANGE, ctx, {
    targetType: AUDIT_TARGET_TYPE.USER,
    targetId: event.targetUserId,
    metadata: {
      previousRole: event.previousRole,
      newRole: event.newRole,
      reason: event.reason
    }
  });
};

export const auditPermissionChange = async (
  ctx: AuditContext,
  event: PermissionChangeEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.USER_PERMISSIONS_CHANGE, ctx, {
    targetType: AUDIT_TARGET_TYPE.USER,
    targetId: event.targetUserId,
    metadata: {
      added: event.added,
      removed: event.removed,
      reason: event.reason
    }
  });
};

export const auditDisappearingMessagesChange = async (
  ctx: AuditContext,
  event: DisappearingMessagesChangeEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.CONVERSATION_DISAPPEARING_MESSAGES_CHANGE, ctx, {
    targetType: AUDIT_TARGET_TYPE.CONVERSATION,
    targetId: event.conversationId,
    metadata: {
      conversationType: event.conversationType,
      previousDuration: event.previousDuration,
      newDuration: event.newDuration
    }
  });
};

export const auditMessageExpiredNow = async (
  ctx: AuditContext,
  event: MessageExpiredNowEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.MESSAGE_EXPIRED_NOW, ctx, {
    targetType: AUDIT_TARGET_TYPE.MESSAGE,
    targetId: event.messageId,
    metadata: {
      conversationId: event.conversationId,
      reason: event.reason
    }
  });
};

export const auditStoryRemoved = async (
  ctx: AuditContext,
  event: StoryRemovedEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.STORY_REMOVED, ctx, {
    targetType: AUDIT_TARGET_TYPE.STORY,
    targetId: event.storyId,
    metadata: {
      authorId: event.authorId,
      removedBy: event.removedBy
    }
  });
};

export const auditStoryReported = async (
  ctx: AuditContext,
  event: StoryReportedEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.STORY_REPORTED, ctx, {
    targetType: AUDIT_TARGET_TYPE.STORY,
    targetId: event.storyId,
    metadata: {
      authorId: event.authorId,
      reason: event.reason,
      hasDetails: event.hasDetails
    }
  });
};

export const auditReportCreated = async (
  ctx: AuditContext,
  event: ReportCreatedEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.REPORT_CREATED, ctx, {
    targetType: AUDIT_TARGET_TYPE.REPORT,
    targetId: event.reportId,
    metadata: {
      reportTargetType: event.targetType,
      reportTargetId: event.targetId,
      reason: event.reason,
      hasDetails: event.hasDetails
    }
  });
};

export const auditReportStatusChanged = async (
  ctx: AuditContext,
  event: ReportStatusChangedEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.REPORT_STATUS_CHANGED, ctx, {
    targetType: AUDIT_TARGET_TYPE.REPORT,
    targetId: event.reportId,
    metadata: {
      previousStatus: event.previousStatus,
      newStatus: event.newStatus,
      reportTargetType: event.targetType,
      reportTargetId: event.targetId,
      hasNote: event.hasNote
    }
  });
};

export const auditModerationAction = async (
  ctx: AuditContext,
  event: ModerationActionEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.MODERATION_ACTION, ctx, {
    targetType: AUDIT_TARGET_TYPE.MODERATION_ACTION,
    targetId: event.actionId,
    metadata: {
      actionType: event.actionType,
      moderationTargetType: event.targetType,
      moderationTargetId: event.targetId,
      relatedReportId: event.relatedReportId,
      hasReason: event.hasReason,
      hasMetadata: event.hasMetadata
    }
  });
};

export const auditLoginFailed = async (
  ctx: AuditContext,
  event: LoginFailedEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.USER_LOGIN_FAILED, ctx, {
    targetType: AUDIT_TARGET_TYPE.USER,
    // The audit row stores only what the caller passed; the identifier hint
    // is intentionally coarse so the audit table cannot be used to enumerate
    // every email/phone tried against the login endpoint.
    metadata: {
      identifierType: event.identifierType,
      identifierHint: event.identifierHint
    }
  });
};

export const auditPasswordChanged = async (
  ctx: AuditContext,
  event: PasswordChangedEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.USER_PASSWORD_CHANGED, ctx, {
    targetType: AUDIT_TARGET_TYPE.USER,
    targetId: event.userId,
    metadata: { sessionsRevoked: event.sessionsRevoked }
  });
};

export const auditSessionsRevokedAll = async (
  ctx: AuditContext,
  event: SessionRevokedAllEvent
): Promise<void> => {
  await emitAudit(AUDIT_ACTION.SESSION_REVOKED_ALL, ctx, {
    targetType: AUDIT_TARGET_TYPE.SESSION,
    targetId: event.userId,
    metadata: { revokedCount: event.revokedCount }
  });
};
