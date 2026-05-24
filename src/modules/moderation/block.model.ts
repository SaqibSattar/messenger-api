import mongoose, { Schema, type Model, type Types } from 'mongoose';
import { BLOCK_REASON_MAX_LENGTH, type BlockDto } from './block.types';

export interface BlockAttrs {
  blockerId: Types.ObjectId;
  blockedUserId: Types.ObjectId;
  reason?: string;
}

export interface BlockDocument extends BlockAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const blockSchema = new Schema<BlockDocument>(
  {
    blockerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    blockedUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    reason: {
      type: String,
      trim: true,
      maxlength: BLOCK_REASON_MAX_LENGTH
    }
  },
  { timestamps: true, strict: 'throw' }
);

// At most one block record per (blocker, blocked) pair. The directional pair
// is intentional — Alice blocking Bob is a separate row from Bob blocking
// Alice, but neither side can produce duplicate rows for the same direction.
blockSchema.index({ blockerId: 1, blockedUserId: 1 }, { unique: true });

// Reverse lookup: "did anyone block this user?" — used by the cross-module
// `isBlockedBetween` helper.
blockSchema.index({ blockedUserId: 1, blockerId: 1 });

export const toBlockDto = (doc: BlockDocument): BlockDto => {
  const dto: BlockDto = {
    id: (doc._id as Types.ObjectId).toString(),
    blockerId: doc.blockerId.toString(),
    blockedUserId: doc.blockedUserId.toString(),
    createdAt: doc.createdAt.toISOString()
  };
  if (doc.reason) dto.reason = doc.reason;
  return dto;
};

export const Block: Model<BlockDocument> =
  (mongoose.models.Block as Model<BlockDocument>) ||
  mongoose.model<BlockDocument>('Block', blockSchema);
