import {
  BadRequestError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import { auditPermissionChange, auditRoleChange } from '../../utils/audit';
import type { AuditContext } from '../../utils/audit';
import { User, toUserDto } from '../users/user.model';
import type { UserDto } from '../users/user.types';
import {
  Session,
  SESSION_REVOKED_REASON
} from '../sessions/session.model';
import {
  ALL_PERMISSIONS,
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

  auditRoleChange(audit, {
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

  auditPermissionChange(audit, {
    targetUserId: target._id.toString(),
    added,
    removed,
    reason: input.reason
  });

  return toUserDto(target);
};
