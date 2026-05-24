import {
  BadRequestError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import { auditPermissionChange, auditRoleChange } from '../../utils/audit';
import type { AuditContext } from '../../utils/audit';
import { isMongoReady } from '../../db/mongo';
import { isRedisReady } from '../../db/redis';
import { User, toUserDto } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import type { UserDto } from '../users/user.types';
import {
  Session,
  SESSION_REVOKED_REASON
} from '../sessions/session.model';
import { Conversation } from '../conversations/conversation.model';
import { Message } from '../messages/message.model';
import { Report } from '../moderation/report.model';
import { REPORT_STATUS } from '../moderation/report.types';
import { ModerationAction } from '../moderation/moderationAction.model';
import { AuditLog } from './auditLog.model';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  type Permission
} from '../permissions/permissions.constants';
import {
  assertCanAssignRole,
  assertCanManageUserRecord,
  type AuthenticatedActor
} from '../permissions/authorization';
import type {
  UpdateCustomPermissionsInput,
  UpdateRoleInput
} from './admin.validation';

const PERMISSION_SET = new Set<Permission>(ALL_PERMISSIONS);

const diffPermissions = (
  previous: Permission[],
  next: Permission[]
): { added: Permission[]; removed: Permission[] } => {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    added: next.filter((p) => !previousSet.has(p)),
    removed: previous.filter((p) => !nextSet.has(p))
  };
};

const revokeAllSessions = async (
  userId: string,
  reason:
    | typeof SESSION_REVOKED_REASON.LOGOUT_ALL
    | typeof SESSION_REVOKED_REASON.PASSWORD_CHANGE
): Promise<void> => {
  await Session.updateMany(
    { userId, revokedAt: { $exists: false } },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: reason
      }
    }
  );
};

export const updateUserRole = async (
  actor: AuthenticatedActor,
  targetUserId: string,
  input: UpdateRoleInput,
  audit: AuditContext
): Promise<UserDto> => {
  if (actor.id === targetUserId) {
    // A user must not be able to escalate (or even change) their own role.
    throw new ForbiddenError('You cannot change your own role');
  }

  const target = await User.findById(targetUserId);
  if (!target) throw new NotFoundError('User not found');

  assertCanManageUserRecord({ id: target._id.toString(), role: target.role }, actor);
  assertCanAssignRole(actor, target.role, input.role);

  if (target.role === input.role) {
    return toUserDto(target);
  }

  const previousRole = target.role;
  target.role = input.role;
  await target.save();

  // Bumping the role server-side takes effect on the next request because
  // requireAuth reads the role from the DB; we still force a re-auth so the
  // user re-establishes a session with the new role and any cached client
  // state is rebuilt.
  await revokeAllSessions(target._id.toString(), SESSION_REVOKED_REASON.LOGOUT_ALL);

  await auditRoleChange(audit, {
    targetUserId: target._id.toString(),
    previousRole,
    newRole: input.role,
    reason: input.reason
  });

  return toUserDto(target);
};

export const updateUserCustomPermissions = async (
  actor: AuthenticatedActor,
  targetUserId: string,
  input: UpdateCustomPermissionsInput,
  audit: AuditContext
): Promise<UserDto> => {
  if (actor.id === targetUserId) {
    throw new ForbiddenError('You cannot change your own permissions');
  }

  // Reject any permission strings that escaped Zod (defense in depth — Zod
  // already validates against ALL_PERMISSIONS; this catches programmer
  // mistakes if the schema is ever loosened).
  const invalid = input.customPermissions.filter((p) => !PERMISSION_SET.has(p));
  if (invalid.length > 0) {
    throw new BadRequestError('Unknown permission', { invalid });
  }
  // Deduplicate to keep storage clean and audits readable.
  const next = Array.from(new Set(input.customPermissions));

  const target = await User.findById(targetUserId);
  if (!target) throw new NotFoundError('User not found');

  assertCanManageUserRecord({ id: target._id.toString(), role: target.role }, actor);

  const previous = [...(target.customPermissions ?? [])];
  const { added, removed } = diffPermissions(previous, next);
  if (added.length === 0 && removed.length === 0) {
    return toUserDto(target);
  }

  target.customPermissions = next;
  await target.save();

  await revokeAllSessions(target._id.toString(), SESSION_REVOKED_REASON.LOGOUT_ALL);

  await auditPermissionChange(audit, {
    targetUserId: target._id.toString(),
    added,
    removed,
    reason: input.reason
  });

  return toUserDto(target);
};

// ---------------------------------------------------------------------------
// System summary
// ---------------------------------------------------------------------------
//
// Privacy-safe aggregate view for admin dashboards. Returns only collection
// counts and 24h activity totals — no user identifiers, no message bodies,
// no IP addresses. Intended for the admin overview page; large-scale ops
// metrics live behind the separate `/metrics` endpoint.

export interface SystemSummary {
  generatedAt: string;
  uptimeSeconds: number;
  dependencies: { mongo: boolean; redis: boolean };
  users: {
    total: number;
    active: number;
    suspended: number;
    deactivated: number;
  };
  conversations: number;
  messagesLast24h: number;
  openReports: number;
  moderationActionsLast24h: number;
  auditLogsLast24h: number;
  activeSessions: number;
}

const MS_24H = 24 * 60 * 60 * 1000;

export const getSystemSummary = async (
  actor: AuthenticatedActor
): Promise<SystemSummary> => {
  // Service-level double check; the route also enforces this.
  if (!actor.permissions.includes(PERMISSIONS.ADMIN_SYSTEM_READ)) {
    throw new ForbiddenError('You cannot view system summary');
  }

  const since = new Date(Date.now() - MS_24H);

  // Run independent counts in parallel — the summary is read-only and cheap.
  const [
    totalUsers,
    activeUsers,
    suspendedUsers,
    deactivatedUsers,
    conversationCount,
    messagesLast24h,
    openReports,
    moderationActionsLast24h,
    auditLogsLast24h,
    activeSessions
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ status: USER_STATUS.ACTIVE }),
    User.countDocuments({ status: USER_STATUS.SUSPENDED }),
    User.countDocuments({ status: USER_STATUS.DEACTIVATED }),
    Conversation.countDocuments({}),
    Message.countDocuments({ createdAt: { $gte: since } }),
    Report.countDocuments({
      status: { $in: [REPORT_STATUS.OPEN, REPORT_STATUS.REVIEWING] }
    }),
    ModerationAction.countDocuments({ createdAt: { $gte: since } }),
    AuditLog.countDocuments({ createdAt: { $gte: since } }),
    Session.countDocuments({
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() }
    })
  ]);

  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    dependencies: { mongo: isMongoReady(), redis: isRedisReady() },
    users: {
      total: totalUsers,
      active: activeUsers,
      suspended: suspendedUsers,
      deactivated: deactivatedUsers
    },
    conversations: conversationCount,
    messagesLast24h,
    openReports,
    moderationActionsLast24h,
    auditLogsLast24h,
    activeSessions
  };
};
