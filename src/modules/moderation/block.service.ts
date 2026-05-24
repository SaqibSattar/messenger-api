import mongoose, { type FilterQuery, type Types } from 'mongoose';
import {
  BadRequestError,
  NotFoundError
} from '../../utils/errors';
import { User, toPublicUserDto } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import type { AuthenticatedActor } from '../permissions/authorization';
import {
  Block,
  toBlockDto,
  type BlockDocument
} from './block.model';
import type {
  BlockDto,
  BlockListItemDto,
  BlockedUserSummaryDto
} from './block.types';
import type {
  CreateBlockInput,
  ListBlocksQuery
} from './block.validation';

const toObjectId = (id: string): Types.ObjectId => new mongoose.Types.ObjectId(id);

// Returns true if either side has blocked the other. The check is symmetric on
// purpose — once a block exists in either direction, direct interaction (DM
// creation, direct-message sending) is severed for both users. The collection
// is small per user (most accounts have zero blocks; abusers are bounded by
// rate limits), so the two-document lookup is cheap.
export const isBlockedBetween = async (
  userIdA: string,
  userIdB: string
): Promise<boolean> => {
  if (userIdA === userIdB) return false;
  const a = toObjectId(userIdA);
  const b = toObjectId(userIdB);
  const hit = await Block.exists({
    $or: [
      { blockerId: a, blockedUserId: b },
      { blockerId: b, blockedUserId: a }
    ]
  });
  return hit !== null;
};

// Directional check: "did `blockerId` specifically block `blockedUserId`?".
// Useful when we want to gate behavior on the blocker's own decision rather
// than the symmetric block status (e.g. when surfacing "you are blocked" to a
// caller would leak the other side's decision).
export const hasBlocked = async (
  blockerId: string,
  blockedUserId: string
): Promise<boolean> => {
  if (blockerId === blockedUserId) return false;
  const hit = await Block.exists({
    blockerId: toObjectId(blockerId),
    blockedUserId: toObjectId(blockedUserId)
  });
  return hit !== null;
};

export const createBlock = async (
  actor: AuthenticatedActor,
  input: CreateBlockInput
): Promise<BlockDto> => {
  if (input.blockedUserId === actor.id) {
    throw new BadRequestError('You cannot block yourself');
  }

  // Confirm the target exists and is an addressable account. Blocking a
  // deactivated/suspended user is harmless, so only the "doesn't exist" case
  // is rejected.
  const target = await User.findById(input.blockedUserId).select('_id');
  if (!target) {
    throw new NotFoundError('User not found');
  }

  try {
    const block = await Block.create({
      blockerId: toObjectId(actor.id),
      blockedUserId: toObjectId(input.blockedUserId),
      ...(input.reason ? { reason: input.reason } : {})
    });
    return toBlockDto(block);
  } catch (err) {
    if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
      // Idempotent: the caller already blocks this user. Return the existing
      // record so the client can treat repeated calls as success.
      const existing = await Block.findOne({
        blockerId: toObjectId(actor.id),
        blockedUserId: toObjectId(input.blockedUserId)
      });
      if (existing) return toBlockDto(existing);
    }
    throw err;
  }
};

export const removeBlock = async (
  actor: AuthenticatedActor,
  blockedUserId: string
): Promise<void> => {
  const result = await Block.deleteOne({
    blockerId: toObjectId(actor.id),
    blockedUserId: toObjectId(blockedUserId)
  });
  if (result.deletedCount === 0) {
    throw new NotFoundError('Block not found');
  }
};

export const listBlocks = async (
  actor: AuthenticatedActor,
  query: ListBlocksQuery
): Promise<{ items: BlockListItemDto[]; nextCursor: string | null }> => {
  const filter: FilterQuery<BlockDocument> = {
    blockerId: toObjectId(actor.id)
  };
  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  const blocks = await Block.find(filter).sort({ _id: -1 }).limit(query.limit + 1);
  const hasMore = blocks.length > query.limit;
  const page = hasMore ? blocks.slice(0, query.limit) : blocks;

  if (page.length === 0) {
    return { items: [], nextCursor: null };
  }

  const blockedIds = page.map((b) => b.blockedUserId);
  const users = await User.find({ _id: { $in: blockedIds } });
  const userById = new Map(
    users.map((u) => [(u._id as Types.ObjectId).toString(), u])
  );

  const items: BlockListItemDto[] = [];
  for (const b of page) {
    const user = userById.get(b.blockedUserId.toString());
    if (!user) continue;
    // Use the public DTO so we never leak the blocked user's email/phone/role.
    // Inactive accounts still appear in the list — they're useful context for
    // the blocker even if the account is gone, and we hide nothing they didn't
    // already know.
    const pub = toPublicUserDto(user);
    const summary: BlockedUserSummaryDto = {
      id: pub.id,
      displayName:
        user.status === USER_STATUS.ACTIVE ? pub.displayName : 'Deleted user'
    };
    if (pub.username) summary.username = pub.username;
    if (pub.avatarUrl) summary.avatarUrl = pub.avatarUrl;
    items.push({ block: toBlockDto(b), blockedUser: summary });
  }

  const lastId = page[page.length - 1]._id as Types.ObjectId;
  return {
    items,
    nextCursor: hasMore ? lastId.toString() : null
  };
};
