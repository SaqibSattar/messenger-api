import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  MODERATION_ACTION_TYPES,
  MODERATION_REASON_MAX_LENGTH,
  MODERATION_TARGET_TYPES,
  type ModerationActionDto,
  type ModerationActionType,
  type ModerationTargetType
} from './moderation.types';

export interface ModerationActionAttrs {
  moderatorId: Types.ObjectId;
  actionType: ModerationActionType;
  targetType: ModerationTargetType;
  targetId: Types.ObjectId;
  reason: string;
  metadata?: Record<string, unknown>;
  relatedReportId?: Types.ObjectId;
}

export interface ModerationActionDocument
  extends ModerationActionAttrs,
    mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const moderationActionSchema = new Schema<ModerationActionDocument>(
  {
    moderatorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    actionType: {
      type: String,
      enum: MODERATION_ACTION_TYPES,
      required: true
    },
    targetType: {
      type: String,
      enum: MODERATION_TARGET_TYPES,
      required: true
    },
    targetId: { type: Schema.Types.ObjectId, required: true },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: MODERATION_REASON_MAX_LENGTH
    },
    // `strict: false` on this single field accepts an arbitrary JSON blob
    // (already validated by Zod upstream). The parent schema is `strict: throw`
    // so unknown top-level fields still fail.
    metadata: { type: Schema.Types.Mixed },
    relatedReportId: { type: Schema.Types.ObjectId, ref: 'Report' }
  },
  { timestamps: true, strict: 'throw' }
);

// Most queries are "actions taken against this target, newest first" and
// "actions by this moderator, newest first".
moderationActionSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
moderationActionSchema.index({ moderatorId: 1, createdAt: -1 });
moderationActionSchema.index({ relatedReportId: 1 });

export const toModerationActionDto = (
  doc: ModerationActionDocument
): ModerationActionDto => {
  const dto: ModerationActionDto = {
    id: (doc._id as Types.ObjectId).toString(),
    moderatorId: doc.moderatorId.toString(),
    actionType: doc.actionType,
    targetType: doc.targetType,
    targetId: doc.targetId.toString(),
    reason: doc.reason,
    createdAt: doc.createdAt.toISOString()
  };
  if (doc.metadata && Object.keys(doc.metadata).length > 0) {
    dto.metadata = { ...doc.metadata };
  }
  if (doc.relatedReportId) {
    dto.relatedReportId = doc.relatedReportId.toString();
  }
  return dto;
};

export const ModerationAction: Model<ModerationActionDocument> =
  (mongoose.models.ModerationAction as Model<ModerationActionDocument>) ||
  mongoose.model<ModerationActionDocument>(
    'ModerationAction',
    moderationActionSchema
  );
