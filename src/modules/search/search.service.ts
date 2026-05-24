import mongoose, { type FilterQuery, type Types } from 'mongoose';
import { NotFoundError } from '../../utils/errors';
import type { AuthenticatedActor } from '../permissions/authorization';
import {
  Conversation,
  toConversationDto,
  type ConversationDocument
} from '../conversations/conversation.model';
import {
  ConversationMember,
  type ConversationMemberDocument
} from '../conversations/conversationMember.model';
import {
  Message,
  toMessageDto,
  type MessageDocument
} from '../messages/message.model';
import { User, toPublicUserDto } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import { canDiscoverUser } from '../privacy/privacy.service';
import type {
  SearchConversationsQuery,
  SearchMessagesQuery,
  SearchUsersQuery
} from './search.validation';
import type {
  MessageSearchHit,
  SearchConversationsResult,
  SearchMessagesResult,
  SearchUsersResult
} from './search.types';

const toObjectId = (id: string): Types.ObjectId =>
  new mongoose.Types.ObjectId(id);

// Escape every regex metacharacter so user input lands in a Mongo $regex
// query as a literal-string match. Without this, a search for `.*` would
// match every document and a search for `(a` would throw a regex error.
// This is the load-bearing safety check — every search query is funneled
// through it before reaching the database.
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildLiteralRegex = (q: string): RegExp =>
  // Anchored with `i` only — substring match, case-insensitive. We do NOT
  // honor `g` (global) here; Mongo only needs to find a match, not enumerate
  // all of them.
  new RegExp(escapeRegex(q), 'i');

// Page-size guard kept in one place. Mongo accepts limit + 1 to detect
// "has more" without an extra count call.
const limitWithOverflow = (limit: number): number => limit + 1;

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

interface MembershipSnapshot {
  conversationIds: Types.ObjectId[];
  byConversationId: Map<string, ConversationMemberDocument>;
}

const loadMyActiveMemberships = async (
  userId: string
): Promise<MembershipSnapshot> => {
  const memberships = await ConversationMember.find({
    userId: toObjectId(userId),
    leftAt: { $exists: false }
  });
  const conversationIds = memberships.map((m) => m.conversationId);
  const byConversationId = new Map<string, ConversationMemberDocument>();
  for (const m of memberships) {
    byConversationId.set(m.conversationId.toString(), m);
  }
  return { conversationIds, byConversationId };
};

export const searchConversations = async (
  actor: AuthenticatedActor,
  query: SearchConversationsQuery
): Promise<SearchConversationsResult> => {
  const { conversationIds } = await loadMyActiveMemberships(actor.id);
  if (conversationIds.length === 0) {
    return { items: [], nextCursor: null };
  }

  const regex = buildLiteralRegex(query.q);

  // Match by group title. Direct conversations have no title field, so they
  // are not surfaced via this endpoint — searching for a counterparty's
  // display name is handled by the /search/users endpoint. This intentional
  // scoping keeps the implementation simple and avoids fanning out a join
  // against the users collection for every search call.
  const filter: FilterQuery<ConversationDocument> = {
    _id: { $in: conversationIds },
    title: regex
  };
  if (query.cursor) {
    filter._id = {
      $in: conversationIds,
      $lt: toObjectId(query.cursor)
    };
  }

  const docs = await Conversation.find(filter)
    .sort({ _id: -1 })
    .limit(limitWithOverflow(query.limit));

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;

  const items = page.map(toConversationDto);
  const nextCursor =
    hasMore && page.length > 0
      ? (page[page.length - 1]._id as Types.ObjectId).toString()
      : null;

  return { items, nextCursor };
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const searchMessages = async (
  actor: AuthenticatedActor,
  query: SearchMessagesQuery
): Promise<SearchMessagesResult> => {
  const { conversationIds, byConversationId } = await loadMyActiveMemberships(
    actor.id
  );

  // If the caller pinned a conversationId, enforce membership at the
  // resource level FIRST — even before the empty-memberships short-circuit,
  // so a non-member with zero memberships still gets a 404 rather than the
  // ambiguous empty result that would tell them the id is real.
  let scopedIds: Types.ObjectId[];
  if (query.conversationId) {
    if (!byConversationId.has(query.conversationId)) {
      throw new NotFoundError('Conversation not found');
    }
    scopedIds = [toObjectId(query.conversationId)];
  } else {
    if (conversationIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    scopedIds = conversationIds;
  }

  const regex = buildLiteralRegex(query.q);

  // Filter rules:
  //   - text matches the regex
  //   - conversation is one the caller belongs to (scopedIds above)
  //   - message is NOT soft-deleted, NOT expired (job ran), AND not past
  //     its expiresAt window even if the cleanup hasn't run yet — that last
  //     case is the load-bearing one, mirroring toMessageDto's masking rule.
  const now = new Date();
  const filter: FilterQuery<MessageDocument> = {
    conversationId: { $in: scopedIds },
    text: regex,
    deletedAt: { $exists: false },
    expiredAt: { $exists: false },
    // Either there is no expiry, or the expiry is still in the future.
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: { $gt: now } }
    ]
  };
  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  const docs = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(limitWithOverflow(query.limit));

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;

  const items: MessageSearchHit[] = page.map((doc) => ({
    // Search results never carry attachment summaries — keeping the payload
    // small avoids an N+1 hit to the media collection per search call.
    // Clients can fetch the full message via GET /api/v1/messages/:id when
    // the user opens a result.
    message: toMessageDto(doc),
    conversationId: doc.conversationId.toString()
  }));

  const nextCursor =
    hasMore && page.length > 0
      ? (page[page.length - 1]._id as Types.ObjectId).toString()
      : null;

  return { items, nextCursor };
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

// User search is intentionally narrower than conversation/message search:
// it accepts a substring against `username` and a prefix-style match against
// `displayName`. Privacy gates:
//   - Only users with `discoverableByUsername` set to true are surfaced.
//   - Users whose `whoCanFindMe` excludes the caller (e.g. set to `nobody`,
//     or set to `contacts` for a non-contact caller) are filtered out
//     post-query. We over-fetch slightly and then filter so the caller can't
//     enumerate "this user exists but I can't see them" via cardinality.
//   - Deactivated/suspended users never appear.
//   - The caller themselves never appears in their own results.
// Returned shape is always the public DTO — never the full UserDto.
export const searchUsersByText = async (
  actor: AuthenticatedActor,
  query: SearchUsersQuery
): Promise<SearchUsersResult> => {
  const regex = buildLiteralRegex(query.q);

  // Over-fetch so post-filtering for the audience gate doesn't shrink the
  // page below the cap. 3x is conservative — most users keep the default
  // `whoCanFindMe: everyone` so the filter step is a no-op.
  const overfetchLimit = Math.min(query.limit * 3, query.limit + 50);
  const docs = await User.find({
    _id: { $ne: toObjectId(actor.id) },
    status: USER_STATUS.ACTIVE,
    'privacySettings.discoverableByUsername': { $ne: false },
    $or: [{ username: regex }, { displayName: regex }]
  })
    .sort({ _id: 1 })
    .limit(overfetchLimit);

  const items = [];
  for (const u of docs) {
    if (items.length >= query.limit) break;
    if (!(await canDiscoverUser(actor.id, u))) continue;
    items.push(toPublicUserDto(u));
  }
  return { items };
};
