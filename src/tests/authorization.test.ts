import {
  assertCanAccessAttachment,
  assertCanAccessNotification,
  assertCanAssignRole,
  assertCanDeleteAttachment,
  assertCanDeleteMessage,
  assertCanEditMessage,
  assertCanManageConversationMembers,
  assertCanManageUserRecord,
  assertCanReadOwnReport,
  assertCanReviewReport,
  assertCanSendMessageToConversation,
  assertCanUpdateConversationSettings,
  assertConversationMembership,
  assertOwnership,
  type AuthenticatedActor,
  type AttachmentLike,
  type ConversationMembershipLike,
  type MessageLike,
  type NotificationLike,
  type ReportLike
} from '../modules/permissions/authorization';
import {
  PERMISSIONS,
  ROLES,
  resolveEffectivePermissions
} from '../modules/permissions/permissions.constants';
import { ForbiddenError, NotFoundError } from '../utils/errors';

const memberActor = (id = 'u1'): AuthenticatedActor => ({
  id,
  role: ROLES.MEMBER,
  permissions: resolveEffectivePermissions(ROLES.MEMBER)
});

const moderatorActor = (id = 'mod1'): AuthenticatedActor => ({
  id,
  role: ROLES.MODERATOR,
  permissions: resolveEffectivePermissions(ROLES.MODERATOR)
});

const adminActor = (id = 'a1'): AuthenticatedActor => ({
  id,
  role: ROLES.ADMIN,
  permissions: resolveEffectivePermissions(ROLES.ADMIN)
});

const superAdminActor = (id = 's1'): AuthenticatedActor => ({
  id,
  role: ROLES.SUPER_ADMIN,
  permissions: resolveEffectivePermissions(ROLES.SUPER_ADMIN)
});

const membership = (
  overrides: Partial<ConversationMembershipLike> & {
    userId: string;
    conversationId: string;
  }
): ConversationMembershipLike => ({
  role: 'member',
  ...overrides
});

describe('assertOwnership', () => {
  it('passes when ownerId matches', () => {
    expect(() => assertOwnership({ ownerId: 'u1' }, 'u1')).not.toThrow();
  });
  it('throws ForbiddenError when ownerId does not match', () => {
    expect(() => assertOwnership({ ownerId: 'u2' }, 'u1')).toThrow(
      ForbiddenError
    );
  });
});

describe('assertConversationMembership', () => {
  it('rejects when the user has no membership', () => {
    expect(() =>
      assertConversationMembership(null, memberActor(), 'c1')
    ).toThrow(ForbiddenError);
  });

  it('rejects when the membership is for a different conversation', () => {
    const m = membership({ userId: 'u1', conversationId: 'c2' });
    expect(() => assertConversationMembership(m, memberActor(), 'c1')).toThrow(
      ForbiddenError
    );
  });

  it('rejects when the membership is for a different user', () => {
    const m = membership({ userId: 'someone-else', conversationId: 'c1' });
    expect(() => assertConversationMembership(m, memberActor(), 'c1')).toThrow(
      ForbiddenError
    );
  });

  it('rejects when the user has left the conversation', () => {
    const m = membership({
      userId: 'u1',
      conversationId: 'c1',
      leftAt: new Date()
    });
    expect(() => assertConversationMembership(m, memberActor(), 'c1')).toThrow(
      ForbiddenError
    );
  });

  it('passes when the user is an active member', () => {
    const m = membership({ userId: 'u1', conversationId: 'c1' });
    expect(() =>
      assertConversationMembership(m, memberActor(), 'c1')
    ).not.toThrow();
  });

  it('bypasses for actors with message:moderate (platform moderators)', () => {
    expect(() =>
      assertConversationMembership(null, moderatorActor(), 'c1')
    ).not.toThrow();
  });
});

describe('assertCanManageConversationMembers / settings', () => {
  it('requires an active admin-or-owner role on the conversation', () => {
    const memberMembership = membership({
      userId: 'u1',
      conversationId: 'c1',
      role: 'member'
    });
    expect(() =>
      assertCanManageConversationMembers(memberMembership, memberActor(), 'c1')
    ).toThrow(ForbiddenError);

    const ownerMembership = membership({
      userId: 'u1',
      conversationId: 'c1',
      role: 'owner'
    });
    expect(() =>
      assertCanManageConversationMembers(ownerMembership, memberActor(), 'c1')
    ).not.toThrow();
    expect(() =>
      assertCanUpdateConversationSettings(ownerMembership, memberActor(), 'c1')
    ).not.toThrow();
  });

  it('platform admins with conversation:manage_members bypass group role', () => {
    expect(() =>
      assertCanManageConversationMembers(null, adminActor(), 'c1')
    ).not.toThrow();
  });
});

describe('assertCanSendMessageToConversation', () => {
  it('rejects a non-member with the message:create permission', () => {
    expect(() =>
      assertCanSendMessageToConversation(
        { conversationId: 'c1', membership: null },
        memberActor()
      )
    ).toThrow(ForbiddenError);
  });

  it('rejects when blocked even if a membership exists', () => {
    const m = membership({ userId: 'u1', conversationId: 'c1' });
    expect(() =>
      assertCanSendMessageToConversation(
        {
          conversationId: 'c1',
          membership: m,
          isBlockedByCounterparty: true
        },
        memberActor()
      )
    ).toThrow(ForbiddenError);
  });

  it('passes for an active member with the message:create permission', () => {
    const m = membership({ userId: 'u1', conversationId: 'c1' });
    expect(() =>
      assertCanSendMessageToConversation(
        { conversationId: 'c1', membership: m },
        memberActor()
      )
    ).not.toThrow();
  });
});

describe('assertCanEditMessage / assertCanDeleteMessage', () => {
  const ownMessage: MessageLike = { senderId: 'u1', conversationId: 'c1' };
  const otherMessage: MessageLike = { senderId: 'u2', conversationId: 'c1' };
  const deletedMessage: MessageLike = {
    senderId: 'u1',
    conversationId: 'c1',
    deletedAt: new Date()
  };

  it('treats deleted/missing messages as not found', () => {
    expect(() => assertCanEditMessage(null, memberActor())).toThrow(
      NotFoundError
    );
    expect(() => assertCanEditMessage(deletedMessage, memberActor())).toThrow(
      NotFoundError
    );
    expect(() => assertCanDeleteMessage(deletedMessage, memberActor())).toThrow(
      NotFoundError
    );
  });

  it('allows the sender to edit/delete their own message', () => {
    expect(() => assertCanEditMessage(ownMessage, memberActor())).not.toThrow();
    expect(() =>
      assertCanDeleteMessage(ownMessage, memberActor())
    ).not.toThrow();
  });

  it("rejects another member editing/deleting someone else's message", () => {
    expect(() => assertCanEditMessage(otherMessage, memberActor())).toThrow(
      ForbiddenError
    );
    expect(() => assertCanDeleteMessage(otherMessage, memberActor())).toThrow(
      ForbiddenError
    );
  });

  it('lets a moderator edit/delete any message via message:moderate', () => {
    expect(() =>
      assertCanEditMessage(otherMessage, moderatorActor())
    ).not.toThrow();
    expect(() =>
      assertCanDeleteMessage(otherMessage, moderatorActor())
    ).not.toThrow();
  });
});

describe('assertCanAccessAttachment / assertCanDeleteAttachment', () => {
  const privateAttachment: AttachmentLike = {
    ownerId: 'u1',
    visibility: 'private'
  };
  const conversationAttachment: AttachmentLike = {
    ownerId: 'u2',
    conversationId: 'c1',
    visibility: 'conversation'
  };

  it('rejects a non-owner reading a private attachment', () => {
    expect(() =>
      assertCanAccessAttachment(privateAttachment, memberActor('other'))
    ).toThrow(ForbiddenError);
  });

  it('allows the owner to read their private attachment', () => {
    expect(() =>
      assertCanAccessAttachment(privateAttachment, memberActor('u1'))
    ).not.toThrow();
  });

  it('requires conversation membership for a conversation-scoped attachment', () => {
    expect(() =>
      assertCanAccessAttachment(conversationAttachment, memberActor('u3'), null)
    ).toThrow(ForbiddenError);

    const m = membership({ userId: 'u3', conversationId: 'c1' });
    expect(() =>
      assertCanAccessAttachment(conversationAttachment, memberActor('u3'), m)
    ).not.toThrow();
  });

  it('rejects a non-owner trying to delete an attachment without moderation rights', () => {
    expect(() =>
      assertCanDeleteAttachment(privateAttachment, memberActor('other'))
    ).toThrow(ForbiddenError);
  });

  it('allows a moderator with media:moderate to delete any attachment', () => {
    expect(() =>
      assertCanDeleteAttachment(privateAttachment, moderatorActor())
    ).not.toThrow();
  });
});

describe('assertCanReviewReport / assertCanReadOwnReport', () => {
  const report: ReportLike = { reporterId: 'u1', status: 'open' };

  it('rejects a member trying to review reports', () => {
    expect(() => assertCanReviewReport(report, memberActor())).toThrow(
      ForbiddenError
    );
  });

  it('allows a moderator with report:review', () => {
    expect(() =>
      assertCanReviewReport(report, moderatorActor())
    ).not.toThrow();
  });

  it('lets a member read only their own reports', () => {
    expect(() =>
      assertCanReadOwnReport(report, memberActor('u1'))
    ).not.toThrow();
    expect(() => assertCanReadOwnReport(report, memberActor('u2'))).toThrow(
      ForbiddenError
    );
  });
});

describe('assertCanAccessNotification', () => {
  const notification: NotificationLike = { userId: 'u1' };
  it('rejects a different user', () => {
    expect(() =>
      assertCanAccessNotification(notification, memberActor('u2'))
    ).toThrow(ForbiddenError);
  });
  it('allows the recipient', () => {
    expect(() =>
      assertCanAccessNotification(notification, memberActor('u1'))
    ).not.toThrow();
  });
});

describe('assertCanManageUserRecord', () => {
  it('rejects when the target outranks the actor', () => {
    expect(() =>
      assertCanManageUserRecord(
        { id: 't1', role: ROLES.SUPER_ADMIN },
        adminActor()
      )
    ).toThrow(ForbiddenError);
  });

  it('rejects when the actor lacks admin:users:manage', () => {
    expect(() =>
      assertCanManageUserRecord(
        { id: 't1', role: ROLES.MEMBER },
        moderatorActor()
      )
    ).toThrow(ForbiddenError);
  });

  it('allows when actor outranks target and has the permission', () => {
    expect(() =>
      assertCanManageUserRecord(
        { id: 't1', role: ROLES.MEMBER },
        adminActor()
      )
    ).not.toThrow();
  });
});

describe('assertCanAssignRole', () => {
  it('rejects assigning a role at or above the actor rank', () => {
    expect(() =>
      assertCanAssignRole(adminActor(), ROLES.MEMBER, ROLES.ADMIN)
    ).toThrow(ForbiddenError);
    expect(() =>
      assertCanAssignRole(adminActor(), ROLES.MEMBER, ROLES.SUPER_ADMIN)
    ).toThrow(ForbiddenError);
  });

  it('rejects modifying a peer or higher-privileged account', () => {
    expect(() =>
      assertCanAssignRole(adminActor(), ROLES.ADMIN, ROLES.MEMBER)
    ).toThrow(ForbiddenError);
  });

  it('allows a super-admin to promote a member to admin', () => {
    expect(() =>
      assertCanAssignRole(superAdminActor(), ROLES.MEMBER, ROLES.ADMIN)
    ).not.toThrow();
  });

  it('allows an admin to demote a moderator to member', () => {
    expect(() =>
      assertCanAssignRole(adminActor(), ROLES.MODERATOR, ROLES.MEMBER)
    ).not.toThrow();
  });
});

describe('PERMISSIONS shape contract', () => {
  it('contains every permission listed in the spec (no regressions)', () => {
    expect(PERMISSIONS.CONVERSATION_MANAGE_MEMBERS).toBeDefined();
    expect(PERMISSIONS.MESSAGE_DISAPPEARING_MANAGE_GROUP).toBeDefined();
    expect(PERMISSIONS.MEDIA_MODERATE).toBeDefined();
    expect(PERMISSIONS.REPORT_READ_OWN).toBeDefined();
    expect(PERMISSIONS.NOTIFICATION_MANAGE_OWN).toBeDefined();
    expect(PERMISSIONS.ADMIN_USERS_READ).toBeDefined();
    expect(PERMISSIONS.ADMIN_SYSTEM_READ).toBeDefined();
  });
});
