import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { MessageReceiptDto } from './message.types';

export interface MessageReceiptAttrs {
  messageId: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  deliveredAt?: Date;
  readAt?: Date;
}

export interface MessageReceiptDocument
  extends MessageReceiptAttrs,
    mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const messageReceiptSchema = new Schema<MessageReceiptDocument>(
  {
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'Message',
      required: true
    },
    // Denormalized so receipt fan-out queries can filter by conversation
    // without a join — important for "mark everything in this conversation
    // delivered" flows added later.
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
    deliveredAt: { type: Date },
    readAt: { type: Date }
  },
  { timestamps: true, strict: 'throw' }
);

// Exactly one receipt per (message, user). Uniqueness lets us upsert without
// racing duplicates, and the index also covers the "did this user receipt
// this message?" lookup.
messageReceiptSchema.index(
  { messageId: 1, userId: 1 },
  { unique: true }
);

// Used to compute "unread count" / "last delivered" for a recipient inside a
// conversation. Sparse on readAt would skip undelivered rows, but we keep it
// non-sparse so the index also serves "list all my receipts in conv".
messageReceiptSchema.index({ conversationId: 1, userId: 1, _id: -1 });

export const toMessageReceiptDto = (
  doc: MessageReceiptDocument
): MessageReceiptDto => {
  const dto: MessageReceiptDto = {
    id: (doc._id as Types.ObjectId).toString(),
    messageId: doc.messageId.toString(),
    userId: doc.userId.toString()
  };
  if (doc.deliveredAt) dto.deliveredAt = doc.deliveredAt.toISOString();
  if (doc.readAt) dto.readAt = doc.readAt.toISOString();
  return dto;
};

export const MessageReceipt: Model<MessageReceiptDocument> =
  (mongoose.models.MessageReceipt as Model<MessageReceiptDocument>) ||
  mongoose.model<MessageReceiptDocument>(
    'MessageReceipt',
    messageReceiptSchema
  );
