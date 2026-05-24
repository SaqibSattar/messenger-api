import crypto from 'crypto';
import mongoose, { type FilterQuery, type Types } from 'mongoose';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import type { AuthenticatedActor } from '../permissions/authorization';
import { assertCanManageConversationMembers } from '../permissions/authorization';
import {
  Conversation,
  type ConversationDocument
} from '../conversations/conversation.model';
import { ConversationMember } from '../conversations/conversationMember.model';
import {
  CONVERSATION_MEMBER_ROLE,
  CONVERSATION_TYPE,
  GROUP_MAX_MEMBERS
} from '../conversations/conversation.types';
import { isBlockedBetween } from '../moderation/block.service';
import {
  InviteLink,
  toInviteLinkDto,
  type InviteLinkDocument
} from './inviteLink.model';
import {
  INVITE_DEFAULT_TTL_SECONDS,
  INVITE_MAX_ACTIVE_PER_CONVERSATION,
  INVITE_TOKEN_BYTES,
  type InviteLinkDto,
  type InviteLinkWithTokenDto,
  type JoinByInviteResultDto
} from './invite.types';
import type { CreateInviteInput } from './invite.validation';

const toObjectId = (id: string): Types.ObjectId =>
  new mongoose.Types.ObjectId(id);

const hashToken = (token: string): string =>
  // Constant-cost SHA-256: the threat model is database leak, not online
  // brute force. The token length (192 bits) makes a brute-force search of
  // any single token cost-prohibitive.
  crypto.createHash('sha256').update(token).digest('hex');

const generateToken = (): string =>
  // base64url: URL-safe alphabet, no padding. Length = ceil(N * 4 / 3).
  crypto.randomBytes(INVITE_TOKEN_BYTES).toString('base64url');

const fetchConversationOr404 = async (
  conversationId: string
): Promise<ConversationDocument> => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new NotFoundError('Conversation not found');
  return conv;
};

// "Active" = not revoked, not over maxUses, not past expiry. We use a single
// Mongo expression rather than fetching + filtering in code so the count
// stays consistent across concurrent calls.
const activeFilter = (
  conversationId: Types.ObjectId
): FilterQuery<InviteLinkDocument> => {
  const now = new Date();
  return {
    conversationId,
    revokedAt: { $exists: false },
    $and: [
      {
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: { $gt: now } }
        ]
      },
      {
        $or: [
          { maxUses: { $exists: false } },
          { $expr: { $lt: ['$useCount', '$maxUses'] } }
        ]
      }
    ]
  };
};

// ---------------------------------------------------------------------------
// Create / revoke
// ---------------------------------------------------------------------------

export const createInvite = async (
  actor: AuthenticatedActor,
  conversationId: string,
  input: CreateInviteInput
): Promise<InviteLinkWithTokenDto> => {
  const conv = await fetchConversationOr404(conversationId);

  // Group-only. Direct conversations have a fixed 2-member shape and a
  // join-by-token would corrupt it.
  if (conv.type !== CONVERSATION_TYPE.GROUP) {
    throw new BadRequestError(
      'Invite links can only be created for group conversations'
    );
  }

  // Membership + admin-role check. Mirrors addMembers — invite creation is
  // the same authority surface as direct add.
  const membership = await ConversationMember.findOne({
    conversationId: conv._id,
    userId: toObjectId(actor.id),
    leftAt: { $exists: false }
  });
  assertCanManageConversationMembers(membership, actor, conversationId);

  // Bound active invite count per conversation. Soft cap to keep listings
  // bounded; a future bulk-revoke endpoint would be the escape hatch.
  const activeCount = await InviteLink.countDocuments(
    activeFilter(conv._id as Types.ObjectId)
  );
  if (activeCount >= INVITE_MAX_ACTIVE_PER_CONVERSATION) {
    throw new ConflictError(
      `This conversation already has the maximum number of active invite links (${INVITE_MAX_ACTIVE_PER_CONVERSATION}). Revoke one before creating another.`
    );
  }

  const ttl = input.expiresInSeconds ?? INVITE_DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  // Token + hash. Retry on the (vanishingly rare) hash collision so callers
  // never see an opaque write failure.
  let token = generateToken();
  let tokenHash = hashToken(token);
  let attempts = 0;
  // 5 attempts is overkill (collision probability ~2^-256) but the loop also
  // covers a race where two concurrent calls picked the same token, which is
  // technically possible if randomBytes is mocked or replayed.
  while (attempts < 5) {
    try {
      const doc = await InviteLink.create({
        conversationId: conv._id,
        createdBy: toObjectId(actor.id),
        tokenHash,
        expiresAt,
        ...(input.maxUses ? { maxUses: input.maxUses } : {}),
        useCount: 0
      });
      return { ...toInviteLinkDto(doc), token };
    } catch (err) {
      if (
        err instanceof mongoose.mongo.MongoServerError &&
        err.code === 11000
      ) {
        token = generateToken();
        tokenHash = hashToken(token);
        attempts += 1;
        continue;
      }
      throw err;
    }
  }
  throw new ConflictError('Could not allocate a unique invite token');
};

export const revokeInvite = async (
  actor: AuthenticatedActor,
  inviteId: string
): Promise<void> => {
  const invite = await InviteLink.findById(inviteId);
  if (!invite) throw new NotFoundError('Invite not found');

  // Resource-level guard: only an admin of the conversation (or a platform
  // CONVERSATION_MANAGE_MEMBERS holder) may revoke. We re-fetch membership
  // for the actor — the invite document doesn't carry the actor's role.
  const conversationId = invite.conversationId.toString();
  const membership = await ConversationMember.findOne({
    conversationId: invite.conversationId,
    userId: toObjectId(actor.id),
    leftAt: { $exists: false }
  });
  assertCanManageConversationMembers(membership, actor, conversationId);

  if (invite.revokedAt) {
    // Idempotent: already revoked is fine.
    return;
  }
  invite.revokedAt = new Date();
  await invite.save();
};

// ---------------------------------------------------------------------------
// List (admin / auditor visibility into outstanding links)
// ---------------------------------------------------------------------------

export const listInvitesForConversation = async (
  actor: AuthenticatedActor,
  conversationId: string
): Promise<InviteLinkDto[]> => {
  const conv = await fetchConversationOr404(conversationId);
  if (conv.type !== CONVERSATION_TYPE.GROUP) {
    throw new BadRequestError('Invites are only available for groups');
  }
  const membership = await ConversationMember.findOne({
    conversationId: conv._id,
    userId: toObjectId(actor.id),
    leftAt: { $exists: false }
  });
  assertCanManageConversationMembers(membership, actor, conversationId);

  // Newest first. We do NOT filter to "active only" — admins frequently want
  // to see expired/revoked links for audit purposes.
  const docs = await InviteLink.find({ conversationId: conv._id }).sort({
    _id: -1
  });
  return docs.map(toInviteLinkDto);
};

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

export const joinByInviteToken = async (
  actor: AuthenticatedActor,
  token: string
): Promise<JoinByInviteResultDto> => {
  const tokenHash = hashToken(token);
  const invite = await InviteLink.findOne({ tokenHash });
  // Use a single generic error for "not found / revoked / expired" so a
  // probing client cannot distinguish "token never existed" from "token was
  // revoked an hour ago".
  const reject = (): never => {
    throw new NotFoundError('Invite is invalid or no longer active');
  };
  if (!invite) reject();
  if (!invite) throw new Error('unreachable'); // narrows for TS

  if (invite.revokedAt) reject();
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) reject();
  if (
    typeof invite.maxUses === 'number' &&
    invite.useCount >= invite.maxUses
  ) {
    reject();
  }

  const conv = await Conversation.findById(invite.conversationId);
  if (!conv) reject();
  if (!conv) throw new Error('unreachable');
  if (conv.type !== CONVERSATION_TYPE.GROUP) {
    // Defensive — shouldn't happen because creation rejects non-groups, but
    // the join path can't trust historical data.
    throw new BadRequestError(
      'This invite cannot be redeemed for the target conversation'
    );
  }

  // Block rule: if the joiner is blocked by (or has blocked) the invite
  // creator, refuse. This intentionally mirrors block semantics elsewhere —
  // a blocker should not be force-added to a group with their blockee via a
  // shared link.
  if (await isBlockedBetween(actor.id, invite.createdBy.toString())) {
    throw new ForbiddenError('You cannot join this conversation');
  }

  // Existing membership: silently succeed if active. This makes the join
  // endpoint idempotent for the same user clicking the link twice.
  const existing = await ConversationMember.findOne({
    conversationId: conv._id,
    userId: toObjectId(actor.id)
  });
  if (existing && !existing.leftAt) {
    return {
      conversationId: conv._id.toString(),
      membershipId: (existing._id as Types.ObjectId).toString()
    };
  }

  // Capacity check using active members only. Re-joiners (leftAt set) count
  // only once they actually re-seat.
  const activeMembers = await ConversationMember.countDocuments({
    conversationId: conv._id,
    leftAt: { $exists: false }
  });
  if (activeMembers + 1 > GROUP_MAX_MEMBERS) {
    throw new ConflictError(
      `Group is at the ${GROUP_MAX_MEMBERS} member limit`
    );
  }

  // Re-seat a previously departed member or insert a fresh row.
  let membership;
  if (existing && existing.leftAt) {
    existing.leftAt = undefined;
    existing.joinedAt = new Date();
    existing.role = CONVERSATION_MEMBER_ROLE.MEMBER;
    await existing.save();
    membership = existing;
  } else {
    membership = await ConversationMember.create({
      conversationId: conv._id,
      userId: toObjectId(actor.id),
      role: CONVERSATION_MEMBER_ROLE.MEMBER
    });
  }

  // Atomically increment useCount AFTER the membership write succeeds.
  // If the increment fails the joiner is still a member — that's the right
  // failure direction (admins can find a stuck counter and revoke; we never
  // want the counter to climb without an actual join).
  await InviteLink.updateOne(
    { _id: invite._id },
    { $inc: { useCount: 1 } }
  );

  return {
    conversationId: conv._id.toString(),
    membershipId: (membership._id as Types.ObjectId).toString()
  };
};
