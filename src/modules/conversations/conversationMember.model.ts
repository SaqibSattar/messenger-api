import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  CONVERSATION_MEMBER_ROLE,
  type ConversationMemberDto,
  type ConversationMemberRole
} from './conversation.types';

export interface ConversationMemberAttrs {
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  role: ConversationMemberRole;
  joinedAt: Date;
  leftAt?: Date;
  mutedUntil?: Date;
  archivedAt?: Date;
  lastReadMessageId?: Types.ObjectId;
}

export interface ConversationMemberDocument
  extends ConversationMemberAttrs,
    mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const conversationMemberSchema = new Schema<ConversationMemberDocument>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    role: {
      type: String,
      enum: Object.values(CONVERSATION_MEMBER_ROLE),
      default: CONVERSATION_MEMBER_ROLE.MEMBER,
      required: true
    },
    joinedAt: { type: Date, required: true, default: () => new Date() },
    leftAt: { type: Date },
    mutedUntil: { type: Date },
    archivedAt: { type: Date },
    lastReadMessageId: { type: Schema.Types.ObjectId }
  },
  { timestamps: true, strict: 'throw' }
);

// One membership document per (conversation, user). A user who leaves and
// rejoins reuses the same document (leftAt is cleared on rejoin) so we never
// accumulate duplicate rows.
conversationMemberSchema.index(
  { conversationId: 1, userId: 1 },
  { unique: true }
);

// Primary inbox query: "active, non-archived memberships for this user,
// newest first by membership id". Cursor pagination sorts by _id desc.
conversationMemberSchema.index({ userId: 1, leftAt: 1, _id: -1 });

// Membership lookups inside a single conversation (eg. role checks, member
// listings) hit conversationId; the unique compound already covers
// (conversationId, userId) lookups.
conversationMemberSchema.index({ conversationId: 1, leftAt: 1 });

export const toConversationMemberDto = (
  doc: ConversationMemberDocument
): ConversationMemberDto => {
  const dto: ConversationMemberDto = {
    id: (doc._id as Types.ObjectId).toString(),
    conversationId: doc.conversationId.toString(),
    userId: doc.userId.toString(),
    role: doc.role,
    joinedAt: doc.joinedAt.toISOString()
  };
  if (doc.leftAt) dto.leftAt = doc.leftAt.toISOString();
  if (doc.mutedUntil) dto.mutedUntil = doc.mutedUntil.toISOString();
  if (doc.archivedAt) dto.archivedAt = doc.archivedAt.toISOString();
  if (doc.lastReadMessageId)
    dto.lastReadMessageId = doc.lastReadMessageId.toString();
  return dto;
};

export const ConversationMember: Model<ConversationMemberDocument> =
  (mongoose.models.ConversationMember as Model<ConversationMemberDocument>) ||
  mongoose.model<ConversationMemberDocument>(
    'ConversationMember',
    conversationMemberSchema
  );
