import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { MessageReactionDto } from './message.types';

export interface MessageReactionAttrs {
  messageId: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  emoji: string;
}

export interface MessageReactionDocument
  extends MessageReactionAttrs,
    mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const messageReactionSchema = new Schema<MessageReactionDocument>(
  {
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'Message',
      required: true
    },
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
    emoji: { type: String, required: true, trim: true }
  },
  { timestamps: true, strict: 'throw' }
);

// One reaction per (message, user, emoji). A user can react with multiple
// distinct emoji on the same message, but cannot stack the same emoji twice.
messageReactionSchema.index(
  { messageId: 1, userId: 1, emoji: 1 },
  { unique: true }
);

// Aggregations like "all reactions on this message" hit messageId.
messageReactionSchema.index({ messageId: 1, _id: 1 });

export const toMessageReactionDto = (
  doc: MessageReactionDocument
): MessageReactionDto => ({
  id: (doc._id as Types.ObjectId).toString(),
  messageId: doc.messageId.toString(),
  userId: doc.userId.toString(),
  emoji: doc.emoji,
  createdAt: doc.createdAt.toISOString()
});

export const MessageReaction: Model<MessageReactionDocument> =
  (mongoose.models.MessageReaction as Model<MessageReactionDocument>) ||
  mongoose.model<MessageReactionDocument>(
    'MessageReaction',
    messageReactionSchema
  );
