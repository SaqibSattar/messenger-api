import mongoose, { type FilterQuery, type Types } from 'mongoose';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import { auditDisappearingMessagesChange } from '../../utils/audit';
import { emitRealtime } from '../../services/realtimeEvents';
import { User } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import { canMessageUser } from '../privacy/privacy.service';
import {
  assertCanManageConversationMembers,
  assertCanManageDisappearingMessages,
  assertCanUpdateConversationSettings,
  assertConversationMembership,
  type AuthenticatedActor
} from '../permissions/authorization';
import { PERMISSIONS } from '../permissions/permissions.constants';
import { isBlockedBetween } from '../moderation/block.service';
import { createNotification } from '../notifications/notification.service';
import {
  NOTIFICATION_ENTITY_TYPE,
  NOTIFICATION_TYPE
} from '../notifications/notification.types';
import {
  Conversation,
  buildDirectKey,
  toConversationDto,
  type ConversationDocument
} from './conversation.model';
import {
  ConversationMember,
  toConversationMemberDto,
  type ConversationMemberDocument
} from './conversationMember.model';
import {
  CONVERSATION_MEMBER_ROLE,
  CONVERSATION_TYPE,
  DEFAULT_CONVERSATION_SETTINGS,
  DISAPPEARING_DURATION_SECONDS,
  GROUP_MAX_MEMBERS,
  type ConversationDto,
  type ConversationMemberDto,
  type DisappearingMessageDuration,
  type MyConversationDto
} from './conversation.types';
import type {
  AddMembersInput,
  CreateDirectConversationInput,
  CreateGroupConversationInput,
  ListConversationsQuery,
  UpdateConversationInput,
  UpdateDisappearingMessagesInput,
  UpdateMemberRoleInput,
  UpdatePreferencesInput,
  UpdateReadPointerInput
} from './conversation.validation';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const toObjectId = (id: string): Types.ObjectId => new mongoose.Types.ObjectId(id);

const findActiveMembership = (
  conversationId: string,
  userId: string
): Promise<ConversationMemberDocument | null> =>
  ConversationMember.findOne({
    conversationId: toObjectId(conversationId),
    userId: toObjectId(userId),
    leftAt: { $exists: false }
  });

const fetchConversationOr404 = async (
  conversationId: string
): Promise<ConversationDocument> => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new NotFoundError('Conversation not found');
  return conv;
};

const ensureActiveUsersExist = async (userIds: string[]): Promise<void> => {
  if (userIds.length === 0) return;
  const ids = userIds.map(toObjectId);
  const count = await User.countDocuments({
    _id: { $in: ids },
    status: USER_STATUS.ACTIVE
  });
  if (count !== userIds.length) {
    throw new BadRequestError('One or more users do not exist or are not active');
  }
};

const requireActiveMembership = async (
  actor: AuthenticatedActor,
  conversationId: string
): Promise<ConversationMemberDocument> => {
  const membership = await findActiveMembership(conversationId, actor.id);
  if (!membership) {
    // Use 404 (not 403) so a non-member cannot probe for existence of
    // conversations they shouldn't know about.
    throw new NotFoundError('Conversation not found');
  }
  return membership;
};

// Resource-level guard used by mutating endpoints. Throws via the centralized
// `assertConversationMembership` helper so the moderation bypass stays in one
// place. The 404-instead-of-403 mapping is intentional and only applied to
// missing membership — actual permission failures keep their 403.
const requireMembershipForMutation = (
  membership: ConversationMemberDocument | null,
  actor: AuthenticatedActor,
  conversationId: string
): void => {
  try {
    assertConversationMembership(membership, actor, conversationId);
  } catch (err) {
    if (err instanceof ForbiddenError && !membership) {
      throw new NotFoundError('Conversation not found');
    }
    throw err;
  }
};

const requireGroupConversation = (conv: ConversationDocument): void => {
  if (conv.type !== CONVERSATION_TYPE.GROUP) {
    throw new BadRequestError('This operation is only allowed on group conversations');
  }
};

const buildMyConversationDto = (
  conv: ConversationDocument,
  membership: ConversationMemberDocument
): MyConversationDto => ({
  conversation: toConversationDto(conv),
  membership: toConversationMemberDto(membership)
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const createDirectConversation = async (
  actor: AuthenticatedActor,
  input: CreateDirectConversationInput
): Promise<MyConversationDto> => {
  if (input.participantId === actor.id) {
    throw new BadRequestError('Cannot start a conversation with yourself');
  }

  await ensureActiveUsersExist([input.participantId]);

  if (await isBlockedBetween(actor.id, input.participantId)) {
    // Generic error — don't reveal who blocked whom.
    throw new ForbiddenError('Cannot start a conversation with this user');
  }

  const directKey = buildDirectKey(actor.id, input.participantId);

  // Fast path: already exists. Privacy doesn't retroactively tear down a
  // pre-existing conversation, so we only run the whoCanMessageMe gate on
  // first-time creation.
  const existing = await Conversation.findOne({ directKey });
  if (!existing) {
    const target = await User.findById(input.participantId);
    if (!target) {
      throw new BadRequestError('One or more users do not exist or are not active');
    }
    if (!(await canMessageUser(actor.id, target))) {
      // Mirror the block-rule error wording so privacy settings cannot be
      // probed via the response text.
      throw new ForbiddenError('Cannot start a conversation with this user');
    }
  }

  if (existing) {
    const membership = await ConversationMember.findOne({
      conversationId: existing._id,
      userId: toObjectId(actor.id)
    });
    if (!membership) {
      // Defensive — should never happen because direct conversations always
      // create both memberships atomically below. If it does, the partial
      // state cannot be silently fixed for this caller.
      throw new ConflictError('Conversation state is inconsistent');
    }
    if (membership.leftAt) {
      // Rejoin: clear leftAt and refresh joinedAt.
      membership.leftAt = undefined;
      membership.joinedAt = new Date();
      await membership.save();
    }
    return buildMyConversationDto(existing, membership);
  }

  let conv: ConversationDocument;
  try {
    conv = await Conversation.create({
      type: CONVERSATION_TYPE.DIRECT,
      createdBy: toObjectId(actor.id),
      directKey,
      settings: { ...DEFAULT_CONVERSATION_SETTINGS }
    });
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      // Race: the counterparty created the same direct conversation first.
      // Re-read and treat as the existing-conversation path.
      const raced = await Conversation.findOne({ directKey });
      if (!raced) throw err;
      const membership = await ConversationMember.findOne({
        conversationId: raced._id,
        userId: toObjectId(actor.id)
      });
      if (!membership) {
        // The other side's create succeeded but it hasn't yet inserted my
        // membership. Insert it now — the unique (conversationId, userId)
        // index keeps this idempotent if both sides race.
        const created = await ConversationMember.create({
          conversationId: raced._id,
          userId: toObjectId(actor.id),
          role: CONVERSATION_MEMBER_ROLE.MEMBER
        });
        return buildMyConversationDto(raced, created);
      }
      return buildMyConversationDto(raced, membership);
    }
    throw err;
  }

  try {
    await ConversationMember.insertMany(
      [
        {
          conversationId: conv._id,
          userId: toObjectId(actor.id),
          role: CONVERSATION_MEMBER_ROLE.MEMBER
        },
        {
          conversationId: conv._id,
          userId: toObjectId(input.participantId),
          role: CONVERSATION_MEMBER_ROLE.MEMBER
        }
      ],
      { ordered: true }
    );
  } catch (err) {
    // Roll back the conversation if we couldn't seat both members; without
    // this the directKey would be permanently taken with no participants.
    await Conversation.deleteOne({ _id: conv._id });
    throw err;
  }

  const membership = await ConversationMember.findOne({
    conversationId: conv._id,
    userId: toObjectId(actor.id)
  });
  if (!membership) throw new ConflictError('Conversation state is inconsistent');
  return buildMyConversationDto(conv, membership);
};

export const createGroupConversation = async (
  actor: AuthenticatedActor,
  input: CreateGroupConversationInput
): Promise<MyConversationDto> => {
  // Dedupe and drop the creator if they accidentally included themselves.
  const otherIds = Array.from(new Set(input.memberIds)).filter(
    (id) => id !== actor.id
  );
  if (otherIds.length === 0) {
    throw new BadRequestError('A group must include at least one other member');
  }
  if (otherIds.length + 1 > GROUP_MAX_MEMBERS) {
    throw new BadRequestError(
      `A group cannot have more than ${GROUP_MAX_MEMBERS} members`
    );
  }

  await ensureActiveUsersExist(otherIds);

  const conv = await Conversation.create({
    type: CONVERSATION_TYPE.GROUP,
    title: input.title,
    avatarUrl: input.avatarUrl,
    createdBy: toObjectId(actor.id),
    settings: {
      ...DEFAULT_CONVERSATION_SETTINGS,
      ...(input.settings ?? {})
    }
  });

  try {
    await ConversationMember.insertMany(
      [
        {
          conversationId: conv._id,
          userId: toObjectId(actor.id),
          role: CONVERSATION_MEMBER_ROLE.OWNER
        },
        ...otherIds.map((id) => ({
          conversationId: conv._id,
          userId: toObjectId(id),
          role: CONVERSATION_MEMBER_ROLE.MEMBER
        }))
      ],
      { ordered: true }
    );
  } catch (err) {
    await Conversation.deleteOne({ _id: conv._id });
    throw err;
  }

  const ownerMembership = await ConversationMember.findOne({
    conversationId: conv._id,
    userId: toObjectId(actor.id)
  });
  if (!ownerMembership) {
    throw new ConflictError('Conversation state is inconsistent');
  }
  return buildMyConversationDto(conv, ownerMembership);
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const listMyConversations = async (
  actor: AuthenticatedActor,
  query: ListConversationsQuery
): Promise<{ items: MyConversationDto[]; nextCursor: string | null }> => {
  const filter: FilterQuery<ConversationMemberDocument> = {
    userId: toObjectId(actor.id),
    leftAt: { $exists: false }
  };
  if (!query.includeArchived) {
    filter.archivedAt = { $exists: false };
  }
  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  const memberships = await ConversationMember.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);

  const hasMore = memberships.length > query.limit;
  const page = hasMore ? memberships.slice(0, query.limit) : memberships;

  if (page.length === 0) {
    return { items: [], nextCursor: null };
  }

  const conversationIds = page.map((m) => m.conversationId);
  const conversations = await Conversation.find({
    _id: { $in: conversationIds }
  });
  const byId = new Map(
    conversations.map((c) => [(c._id as Types.ObjectId).toString(), c])
  );

  const items: MyConversationDto[] = [];
  for (const membership of page) {
    const conv = byId.get(membership.conversationId.toString());
    if (!conv) continue;
    items.push(buildMyConversationDto(conv, membership));
  }

  const lastId = page[page.length - 1]._id as Types.ObjectId;
  return {
    items,
    nextCursor: hasMore ? lastId.toString() : null
  };
};

export interface ConversationDetailsDto {
  conversation: ConversationDto;
  membership: ConversationMemberDto | null;
  members: ConversationMemberDto[];
}

export const getConversation = async (
  actor: AuthenticatedActor,
  conversationId: string
): Promise<ConversationDetailsDto> => {
  const conv = await fetchConversationOr404(conversationId);
  const membership = await findActiveMembership(conversationId, actor.id);

  // Mirror the membership rule: if not a member and not a platform moderator,
  // pretend the conversation does not exist.
  const isModerator = actor.permissions.includes(PERMISSIONS.MESSAGE_MODERATE);
  if (!membership && !isModerator) {
    throw new NotFoundError('Conversation not found');
  }

  const members = await ConversationMember.find({
    conversationId: conv._id,
    leftAt: { $exists: false }
  }).sort({ joinedAt: 1 });

  return {
    conversation: toConversationDto(conv),
    membership: membership ? toConversationMemberDto(membership) : null,
    members: members.map(toConversationMemberDto)
  };
};

// ---------------------------------------------------------------------------
// Update conversation (title / avatar / settings)
// ---------------------------------------------------------------------------

export const updateConversation = async (
  actor: AuthenticatedActor,
  conversationId: string,
  input: UpdateConversationInput
): Promise<ConversationDto> => {
  const conv = await fetchConversationOr404(conversationId);
  const membership = await findActiveMembership(conversationId, actor.id);
  requireMembershipForMutation(membership, actor, conversationId);

  // Direct conversations have no title/avatar to update and no settings the
  // user can flip — block edits outright so a malicious client can't try to
  // weaponize a settings field that only makes sense for groups.
  if (conv.type === CONVERSATION_TYPE.DIRECT) {
    throw new BadRequestError('Direct conversations cannot be edited');
  }

  assertCanUpdateConversationSettings(membership, actor, conversationId);

  if (input.title !== undefined) {
    conv.title = input.title;
  }
  if (input.avatarUrl !== undefined) {
    conv.avatarUrl = input.avatarUrl ?? undefined;
  }
  if (input.settings?.whoCanSendMessages !== undefined) {
    conv.settings.whoCanSendMessages = input.settings.whoCanSendMessages;
  }

  await conv.save();
  return toConversationDto(conv);
};

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const addMembers = async (
  actor: AuthenticatedActor,
  conversationId: string,
  input: AddMembersInput
): Promise<{ added: ConversationMemberDto[] }> => {
  const conv = await fetchConversationOr404(conversationId);
  const membership = await findActiveMembership(conversationId, actor.id);
  requireMembershipForMutation(membership, actor, conversationId);

  requireGroupConversation(conv);
  assertCanManageConversationMembers(membership, actor, conversationId);

  const uniqueIds = Array.from(new Set(input.userIds)).filter(
    (id) => id !== actor.id
  );
  if (uniqueIds.length === 0) {
    throw new BadRequestError('No new members to add');
  }

  await ensureActiveUsersExist(uniqueIds);

  // Bound total membership. Use the active member count so re-adds of left
  // members are counted only once.
  const currentActiveCount = await ConversationMember.countDocuments({
    conversationId: conv._id,
    leftAt: { $exists: false }
  });

  const existing = await ConversationMember.find({
    conversationId: conv._id,
    userId: { $in: uniqueIds.map(toObjectId) }
  });
  const existingById = new Map(
    existing.map((m) => [m.userId.toString(), m])
  );

  const newJoiners = uniqueIds.filter((id) => {
    const e = existingById.get(id);
    return !e || e.leftAt;
  });
  if (currentActiveCount + newJoiners.length > GROUP_MAX_MEMBERS) {
    throw new BadRequestError(
      `Adding these members would exceed the ${GROUP_MAX_MEMBERS} member limit`
    );
  }

  const added: ConversationMemberDocument[] = [];

  for (const id of uniqueIds) {
    const e = existingById.get(id);
    if (e && !e.leftAt) {
      // Already an active member: silently skip rather than 409 so a partial
      // re-add of a list works deterministically.
      continue;
    }
    if (e && e.leftAt) {
      e.leftAt = undefined;
      e.joinedAt = new Date();
      e.role = CONVERSATION_MEMBER_ROLE.MEMBER;
      await e.save();
      added.push(e);
      continue;
    }
    const created = await ConversationMember.create({
      conversationId: conv._id,
      userId: toObjectId(id),
      role: CONVERSATION_MEMBER_ROLE.MEMBER
    });
    added.push(created);
  }

  // Notify each newly added member that they were added to the group. We
  // use the conversation title only when it exists — direct chats never
  // go through this code path, so the title is reliably set. Best-effort:
  // a notification failure must not undo the membership change.
  const inviteTitle = conv.title
    ? `You were added to ${conv.title}`
    : 'You were added to a conversation';
  const conversationIdStr = conv._id.toString();
  for (const m of added) {
    await createNotification({
      userId: m.userId.toString(),
      type: NOTIFICATION_TYPE.CONVERSATION_INVITE,
      title: inviteTitle,
      entityType: NOTIFICATION_ENTITY_TYPE.CONVERSATION,
      entityId: conversationIdStr,
      conversationId: conversationIdStr,
      data: { invitedBy: actor.id }
    }).catch(() => {
      /* swallowed; the membership change itself succeeded */
    });
  }

  return { added: added.map(toConversationMemberDto) };
};

export const removeMember = async (
  actor: AuthenticatedActor,
  conversationId: string,
  targetUserId: string
): Promise<void> => {
  const conv = await fetchConversationOr404(conversationId);
  const membership = await findActiveMembership(conversationId, actor.id);
  requireMembershipForMutation(membership, actor, conversationId);

  requireGroupConversation(conv);
  assertCanManageConversationMembers(membership, actor, conversationId);

  if (targetUserId === actor.id) {
    throw new BadRequestError(
      'Use the leave endpoint to remove yourself from a conversation'
    );
  }

  const target = await findActiveMembership(conversationId, targetUserId);
  if (!target) throw new NotFoundError('Member not found');

  if (target.role === CONVERSATION_MEMBER_ROLE.OWNER) {
    throw new ForbiddenError('The owner cannot be removed');
  }

  target.leftAt = new Date();
  await target.save();
};

export const leaveConversation = async (
  actor: AuthenticatedActor,
  conversationId: string
): Promise<void> => {
  const conv = await fetchConversationOr404(conversationId);
  const membership = await findActiveMembership(conversationId, actor.id);
  if (!membership) throw new NotFoundError('Conversation not found');

  if (conv.type === CONVERSATION_TYPE.DIRECT) {
    // Spec: "direct conversations cannot be left the same way unless product
    // rules allow it". The supported way to hide a direct conversation is the
    // /preferences endpoint (archive).
    throw new BadRequestError(
      'Direct conversations cannot be left; archive it instead'
    );
  }

  if (membership.role === CONVERSATION_MEMBER_ROLE.OWNER) {
    const otherActive = await ConversationMember.countDocuments({
      conversationId: conv._id,
      userId: { $ne: membership.userId },
      leftAt: { $exists: false }
    });
    if (otherActive > 0) {
      throw new BadRequestError(
        'Transfer ownership before leaving the group'
      );
    }
  }

  membership.leftAt = new Date();
  await membership.save();
};

export const updateMemberRole = async (
  actor: AuthenticatedActor,
  conversationId: string,
  targetUserId: string,
  input: UpdateMemberRoleInput
): Promise<ConversationMemberDto> => {
  const conv = await fetchConversationOr404(conversationId);
  const membership = await findActiveMembership(conversationId, actor.id);
  requireMembershipForMutation(membership, actor, conversationId);

  requireGroupConversation(conv);

  // Owner promotion / demotion is owner-only. Other role flips require
  // conversation-admin or higher.
  if (input.role === CONVERSATION_MEMBER_ROLE.OWNER) {
    if (
      !membership ||
      membership.role !== CONVERSATION_MEMBER_ROLE.OWNER
    ) {
      throw new ForbiddenError('Only the owner can transfer ownership');
    }
  } else {
    assertCanManageConversationMembers(membership, actor, conversationId);
  }

  if (targetUserId === actor.id) {
    throw new BadRequestError('Cannot change your own role');
  }

  const target = await findActiveMembership(conversationId, targetUserId);
  if (!target) throw new NotFoundError('Member not found');

  // Block demotion of the existing owner unless the actor is transferring
  // ownership to someone (handled by the OWNER branch above, which moves
  // ownership atomically below).
  if (
    target.role === CONVERSATION_MEMBER_ROLE.OWNER &&
    input.role !== CONVERSATION_MEMBER_ROLE.OWNER
  ) {
    throw new ForbiddenError('The owner role can only be transferred, not demoted');
  }

  if (target.role === input.role) {
    return toConversationMemberDto(target);
  }

  if (input.role === CONVERSATION_MEMBER_ROLE.OWNER) {
    // Transfer: demote the current owner (the actor) to admin, promote the
    // target. Done as two writes; the worst-case interleaving leaves two
    // owners briefly, which is harmless until the actor's save completes.
    if (!membership) throw new ForbiddenError('Only the owner can transfer ownership');
    target.role = CONVERSATION_MEMBER_ROLE.OWNER;
    await target.save();
    membership.role = CONVERSATION_MEMBER_ROLE.ADMIN;
    await membership.save();
  } else {
    target.role = input.role;
    await target.save();
  }

  return toConversationMemberDto(target);
};

// ---------------------------------------------------------------------------
// Per-member preferences (mute, archive, read pointer)
// ---------------------------------------------------------------------------

export const updateReadPointer = async (
  actor: AuthenticatedActor,
  conversationId: string,
  input: UpdateReadPointerInput
): Promise<ConversationMemberDto> => {
  const membership = await requireActiveMembership(actor, conversationId);

  const next = toObjectId(input.lastReadMessageId);
  // ObjectIds are time-ordered, so this rejects attempts to move the pointer
  // backwards. Validating that the message actually belongs to the
  // conversation is the messages module's job (lands in prompt 06).
  if (
    membership.lastReadMessageId &&
    membership.lastReadMessageId.toString() >= next.toString()
  ) {
    return toConversationMemberDto(membership);
  }

  membership.lastReadMessageId = next;
  await membership.save();
  return toConversationMemberDto(membership);
};

// ---------------------------------------------------------------------------
// Disappearing messages
// ---------------------------------------------------------------------------

const durationToSeconds = (
  duration: DisappearingMessageDuration
): number =>
  duration === 'off' ? 0 : DISAPPEARING_DURATION_SECONDS[duration];

export const setDisappearingMessages = async (
  actor: AuthenticatedActor,
  conversationId: string,
  input: UpdateDisappearingMessagesInput
): Promise<ConversationDto> => {
  const conv = await fetchConversationOr404(conversationId);
  const membership = await findActiveMembership(conversationId, actor.id);

  // Resource-level membership check first. We pass through to the dedicated
  // disappearing-messages helper because platform-moderator bypass is wrong
  // here — privacy controls must remain in the hands of conversation members.
  if (!membership) {
    throw new NotFoundError('Conversation not found');
  }

  assertCanManageDisappearingMessages(
    membership,
    actor,
    conversationId,
    conv.type === CONVERSATION_TYPE.GROUP ? 'group' : 'direct'
  );

  const previousDuration = conv.settings.disappearingMessages.duration;
  if (previousDuration === input.duration) {
    // No-op: skip writes and the audit/realtime fan-out so a noisy client
    // can't spam events by re-sending the same value.
    return toConversationDto(conv);
  }

  conv.settings.disappearingMessages = {
    duration: input.duration,
    durationSeconds: durationToSeconds(input.duration),
    updatedBy: toObjectId(actor.id),
    updatedAt: new Date()
  };
  // Mongoose needs to know the nested doc was replaced.
  conv.markModified('settings.disappearingMessages');
  await conv.save();

  const dto = toConversationDto(conv);

  // Audit trail (group changes are the load-bearing case, but logging direct
  // ones too gives moderators a record for incident response). Reason and
  // body are intentionally absent from the log — the change is metadata-only.
  await auditDisappearingMessagesChange(
    { actorId: actor.id },
    {
      conversationId,
      conversationType:
        conv.type === CONVERSATION_TYPE.GROUP ? 'group' : 'direct',
      previousDuration,
      newDuration: input.duration
    }
  );

  emitRealtime('conversation.disappearing_settings_updated', {
    conversationId,
    disappearingMessages: dto.settings.disappearingMessages
  });

  return dto;
};

export const updatePreferences = async (
  actor: AuthenticatedActor,
  conversationId: string,
  input: UpdatePreferencesInput
): Promise<ConversationMemberDto> => {
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  if (input.mutedUntil === null) {
    unset.mutedUntil = 1;
  } else if (typeof input.mutedUntil === 'string') {
    set.mutedUntil = new Date(input.mutedUntil);
  }

  if (input.archived === true) {
    set.archivedAt = new Date();
  } else if (input.archived === false) {
    unset.archivedAt = 1;
  }

  const update: Record<string, Record<string, unknown>> = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (Object.keys(unset).length > 0) update.$unset = unset;

  const updated = await ConversationMember.findOneAndUpdate(
    {
      conversationId: toObjectId(conversationId),
      userId: toObjectId(actor.id),
      leftAt: { $exists: false }
    },
    update,
    { new: true }
  );

  if (!updated) throw new NotFoundError('Conversation not found');
  return toConversationMemberDto(updated);
};
