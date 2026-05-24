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
