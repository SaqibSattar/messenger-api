import { ForbiddenError, NotFoundError } from '../../utils/errors';
import {
  hasPermission,
  PERMISSIONS,
  ROLES,
  type Permission,
  type Role
} from './permissions.constants';

/**
 * Resource-level authorization helpers.
 *
 * These are intentionally shape-based: they operate on already-loaded data
 * passed by the caller, not on collection IDs. Services own the IO (fetching
 * a conversation, membership, message, etc.) and then call the matching
 * `assert*` helper with what they loaded. That keeps the authorization rule
 * in one place — services cannot accidentally skip it, but they also can't
 * pretend a check passed by feeding the helper a forged shape, because the
 * helper still consults the authenticated `actor.id` / `actor.role` /
 * `actor.permissions` that come from the verified session.
 *
 * Future modules (04+) will introduce the concrete Conversation, Membership,
 * Message, Attachment, Report, and Notification models. Those models can
 * conform to the interfaces declared here without this file changing — keep
 * additions to these interfaces minimal and additive.
 */

export interface AuthenticatedActor {
  id: string;
  role: Role;
  permissions: readonly Permission[];
}

const idEq = (
  a: string | { toString(): string } | null | undefined,
  b: string
): boolean => (a == null ? false : a.toString() === b);

const actorHas = (actor: AuthenticatedActor, permission: Permission): boolean =>
  actor.permissions.includes(permission) || hasPermission(actor.role, permission);

const assertPermission = (
  actor: AuthenticatedActor,
  permission: Permission,
  message = 'Insufficient permission'
): void => {
  if (!actorHas(actor, permission)) throw new ForbiddenError(message);
};

// ---------------------------------------------------------------------------
// Generic ownership
// ---------------------------------------------------------------------------

export interface ResourceOwner {
  ownerId: string | { toString(): string };
}

export const assertOwnership = (
  resource: ResourceOwner,
  userId: string,
  message = 'You do not own this resource'
): void => {
  if (!idEq(resource.ownerId, userId)) throw new ForbiddenError(message);
};

// ---------------------------------------------------------------------------
// Conversations and membership
// ---------------------------------------------------------------------------

export const CONVERSATION_MEMBER_ROLES = [
  'member',
  'moderator',
  'admin',
  'owner'
] as const;
export type ConversationMemberRole = (typeof CONVERSATION_MEMBER_ROLES)[number];

export interface ConversationMembershipLike {
  conversationId: string | { toString(): string };
  userId: string | { toString(): string };
  role: ConversationMemberRole;
  leftAt?: Date | null;
  bannedAt?: Date | null;
}

const CONVERSATION_ADMIN_ROLES: readonly ConversationMemberRole[] = [
  'admin',
  'owner'
];

const membershipIsActive = (m: ConversationMembershipLike): boolean =>
  !m.leftAt && !m.bannedAt;

export const assertConversationMembership = (
  membership: ConversationMembershipLike | null | undefined,
  actor: AuthenticatedActor,
  conversationId: string
): void => {
  // Platform moderators with message:moderate can read conversations to
  // investigate reports; the resource-level rule for members is otherwise
  // strict.
  if (actorHas(actor, PERMISSIONS.MESSAGE_MODERATE)) return;

  if (
    !membership ||
    !idEq(membership.userId, actor.id) ||
    !idEq(membership.conversationId, conversationId) ||
    !membershipIsActive(membership)
  ) {
    throw new ForbiddenError('Not a member of this conversation');
  }
};

export const assertCanManageConversationMembers = (
  membership: ConversationMembershipLike | null | undefined,
  actor: AuthenticatedActor,
  conversationId: string
): void => {
  // Platform-level conversation manager bypasses group role.
  if (actorHas(actor, PERMISSIONS.CONVERSATION_MANAGE_MEMBERS)) return;

  if (
    !membership ||
    !idEq(membership.userId, actor.id) ||
    !idEq(membership.conversationId, conversationId) ||
    !membershipIsActive(membership) ||
    !CONVERSATION_ADMIN_ROLES.includes(membership.role)
  ) {
    throw new ForbiddenError(
      'Only conversation admins can manage members'
    );
  }
};

export const assertCanUpdateConversationSettings = (
  membership: ConversationMembershipLike | null | undefined,
  actor: AuthenticatedActor,
  conversationId: string
): void => {
  if (actorHas(actor, PERMISSIONS.CONVERSATION_MANAGE_SETTINGS)) return;

  if (
    !membership ||
    !idEq(membership.userId, actor.id) ||
    !idEq(membership.conversationId, conversationId) ||
    !membershipIsActive(membership) ||
    !CONVERSATION_ADMIN_ROLES.includes(membership.role)
  ) {
    throw new ForbiddenError(
      'Only conversation admins can update settings'
    );
  }
};

// Disappearing-messages authorization. Two layers, applied per chat type:
//
//   - Direct: any active member with `message:disappearing:manage_own` can
//     flip the setting. Matches the product rule that direct participants
//     own their own privacy controls.
//
//   - Group: must be an active member, AND either (a) hold the platform-level
//     `message:disappearing:manage_group` permission (typical bypass for
//     platform admins/super-admins), or (b) hold an admin/owner role inside
//     the conversation itself. The role check is the privacy-critical one —
//     a regular group member cannot flip the setting for the whole group
//     even if they somehow acquired the platform permission.
//
// Platform moderators do NOT bypass this — disappearing-messages is a privacy
// control, not a moderation action; a mod has no business changing it for
// other users.
export const assertCanManageDisappearingMessages = (
  membership: ConversationMembershipLike | null | undefined,
  actor: AuthenticatedActor,
  conversationId: string,
  conversationType: 'direct' | 'group'
): void => {
  if (
    !membership ||
    !idEq(membership.userId, actor.id) ||
    !idEq(membership.conversationId, conversationId) ||
    !membershipIsActive(membership)
  ) {
    throw new ForbiddenError('Not a member of this conversation');
  }

  if (conversationType === 'direct') {
    if (!actorHas(actor, PERMISSIONS.MESSAGE_DISAPPEARING_MANAGE_OWN)) {
      throw new ForbiddenError(
        'You cannot manage disappearing messages in this conversation'
      );
    }
    return;
  }

  const hasPlatformBypass = actorHas(
    actor,
    PERMISSIONS.MESSAGE_DISAPPEARING_MANAGE_GROUP
  );
  const isGroupAdmin = CONVERSATION_ADMIN_ROLES.includes(membership.role);
  if (!hasPlatformBypass && !isGroupAdmin) {
    throw new ForbiddenError(
      'Only group admins can manage disappearing messages'
    );
  }
};

export interface ConversationContext {
  conversationId: string | { toString(): string };
  membership: ConversationMembershipLike | null | undefined;
  isBlockedByCounterparty?: boolean;
}

export const assertCanSendMessageToConversation = (
  ctx: ConversationContext,
  actor: AuthenticatedActor
): void => {
  assertPermission(
    actor,
    PERMISSIONS.MESSAGE_CREATE,
    'You cannot send messages'
  );
  assertConversationMembership(
    ctx.membership,
    actor,
    ctx.conversationId.toString()
  );
  if (ctx.isBlockedByCounterparty) {
    // Mirror the error the blocked user would see for a not-found resource —
    // do not leak "you are blocked" to the sender.
    throw new ForbiddenError('Cannot send messages to this conversation');
  }
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageLike {
  id?: string | { toString(): string };
  senderId: string | { toString(): string };
  conversationId: string | { toString(): string };
  deletedAt?: Date | null;
  createdAt?: Date;
}

export const assertCanEditMessage = (
  message: MessageLike | null | undefined,
  actor: AuthenticatedActor
): void => {
  if (!message || message.deletedAt) throw new NotFoundError('Message not found');

  if (idEq(message.senderId, actor.id)) {
    assertPermission(actor, PERMISSIONS.MESSAGE_EDIT_OWN);
    return;
  }
  // Moderators may edit only via the moderation permission; even then, the
  // service should record the action in the audit log.
  if (actorHas(actor, PERMISSIONS.MESSAGE_MODERATE)) return;
  throw new ForbiddenError('You cannot edit this message');
};

export const assertCanDeleteMessage = (
  message: MessageLike | null | undefined,
  actor: AuthenticatedActor
): void => {
  if (!message || message.deletedAt) throw new NotFoundError('Message not found');

  if (idEq(message.senderId, actor.id)) {
    assertPermission(actor, PERMISSIONS.MESSAGE_DELETE_OWN);
    return;
  }
  if (actorHas(actor, PERMISSIONS.MESSAGE_MODERATE)) return;
  throw new ForbiddenError('You cannot delete this message');
};

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface AttachmentLike {
  id?: string | { toString(): string };
  ownerId: string | { toString(): string };
  conversationId?: string | { toString(): string } | null;
  visibility?: 'private' | 'conversation' | 'public';
}

export const assertCanAccessAttachment = (
  attachment: AttachmentLike | null | undefined,
  actor: AuthenticatedActor,
  membership?: ConversationMembershipLike | null
): void => {
  if (!attachment) throw new NotFoundError('Attachment not found');
  assertPermission(actor, PERMISSIONS.MEDIA_READ);

  if (attachment.visibility === 'public') return;
  if (idEq(attachment.ownerId, actor.id)) return;
  if (actorHas(actor, PERMISSIONS.MEDIA_MODERATE)) return;

  if (attachment.visibility === 'conversation' && attachment.conversationId) {
    assertConversationMembership(
      membership,
      actor,
      attachment.conversationId.toString()
    );
    return;
  }
  throw new ForbiddenError('You cannot access this attachment');
};

export const assertCanDeleteAttachment = (
  attachment: AttachmentLike | null | undefined,
  actor: AuthenticatedActor
): void => {
  if (!attachment) throw new NotFoundError('Attachment not found');
  if (idEq(attachment.ownerId, actor.id)) {
    assertPermission(actor, PERMISSIONS.MEDIA_DELETE_OWN);
    return;
  }
  if (actorHas(actor, PERMISSIONS.MEDIA_MODERATE)) return;
  throw new ForbiddenError('You cannot delete this attachment');
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ReportLike {
  id?: string | { toString(): string };
  reporterId: string | { toString(): string };
  status?: 'open' | 'reviewing' | 'resolved' | 'dismissed';
}

export const assertCanReviewReport = (
  report: ReportLike | null | undefined,
  actor: AuthenticatedActor
): void => {
  if (!report) throw new NotFoundError('Report not found');
  assertPermission(actor, PERMISSIONS.REPORT_REVIEW);
};

export const assertCanReadOwnReport = (
  report: ReportLike | null | undefined,
  actor: AuthenticatedActor
): void => {
  if (!report) throw new NotFoundError('Report not found');
  if (actorHas(actor, PERMISSIONS.REPORT_REVIEW)) return;
  if (
    actorHas(actor, PERMISSIONS.REPORT_READ_OWN) &&
    idEq(report.reporterId, actor.id)
  ) {
    return;
  }
  throw new ForbiddenError('You cannot view this report');
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationLike {
  id?: string | { toString(): string };
  userId: string | { toString(): string };
}

export const assertCanAccessNotification = (
  notification: NotificationLike | null | undefined,
  actor: AuthenticatedActor
): void => {
  if (!notification) throw new NotFoundError('Notification not found');
  assertPermission(actor, PERMISSIONS.NOTIFICATION_READ_OWN);
  if (!idEq(notification.userId, actor.id)) {
    throw new ForbiddenError('You cannot access this notification');
  }
};

// ---------------------------------------------------------------------------
// User / admin records
// ---------------------------------------------------------------------------

export interface TargetUserLike {
  id: string | { toString(): string };
  role: Role;
}

const ROLE_RANK: Record<Role, number> = {
  [ROLES.MEMBER]: 0,
  [ROLES.MODERATOR]: 1,
  [ROLES.ADMIN]: 2,
  [ROLES.SUPER_ADMIN]: 3
};

export const assertCanManageUserRecord = (
  target: TargetUserLike | null | undefined,
  actor: AuthenticatedActor
): void => {
  if (!target) throw new NotFoundError('User not found');
  assertPermission(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
  // Cannot manage a user with a strictly higher role than yourself. This
  // prevents an admin from editing/locking a super-admin.
  if (ROLE_RANK[target.role] > ROLE_RANK[actor.role]) {
    throw new ForbiddenError('Cannot manage a higher-privileged account');
  }
};

export const assertCanAssignRole = (
  actor: AuthenticatedActor,
  targetCurrentRole: Role,
  newRole: Role
): void => {
  assertPermission(actor, PERMISSIONS.ADMIN_USERS_MANAGE);
  const actorRank = ROLE_RANK[actor.role];
  // You cannot assign a role at or above your own rank, and you cannot
  // demote a peer who outranks you.
  if (ROLE_RANK[newRole] >= actorRank) {
    throw new ForbiddenError('Cannot assign a role at or above your own');
  }
  if (ROLE_RANK[targetCurrentRole] >= actorRank) {
    throw new ForbiddenError('Cannot modify a peer or higher-privileged account');
  }
};
