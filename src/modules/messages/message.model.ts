import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  MESSAGE_DELETION_REASON,
  type MessageDeletionReason,
  type MessageDto
} from './message.types';

export interface MessageAttrs {
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  text: string;
  // Reserved for the media module (07). The schema accepts the field so the
  // shape is stable now and migrations are unnecessary later.
  attachments: Types.ObjectId[];
  replyToMessageId?: Types.ObjectId;
  editedAt?: Date;
  deletedAt?: Date;
  deletedBy?: Types.ObjectId;
  deletionReason?: MessageDeletionReason;
}

export interface MessageDocument extends MessageAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<MessageDocument>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    text: { type: String, required: true, default: '' },
    attachments: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Attachment' }],
      default: []
    },
    replyToMessageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    editedAt: { type: Date },
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletionReason: {
      type: String,
      enum: Object.values(MESSAGE_DELETION_REASON)
    }
  },
  { timestamps: true, strict: 'throw' }
);

// Primary read path: paginate messages within a conversation, newest first.
// _id is ObjectId-time-ordered, so a (conversationId, _id desc) cursor avoids
// a separate createdAt sort.
messageSchema.index({ conversationId: 1, _id: -1 });

// Sender history lookups — used by moderation and "messages by user" reports.
messageSchema.index({ senderId: 1, _id: -1 });

// Reply graph queries ("show me replies to this message"). Sparse so messages
// without a parent don't bloat the index.
messageSchema.index(
  { replyToMessageId: 1 },
  { sparse: true }
);

export const toMessageDto = (doc: MessageDocument): MessageDto => {
  const id = (doc._id as Types.ObjectId).toString();
  const dto: MessageDto = {
    id,
    conversationId: doc.conversationId.toString(),
    senderId: doc.senderId.toString(),
    // Deleted messages must not leak their original text via the API. The
    // raw body stays on disk for audit/moderation but is not serialised.
    text: doc.deletedAt ? null : doc.text,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
  if (doc.replyToMessageId) {
    dto.replyToMessageId = doc.replyToMessageId.toString();
  }
  if (doc.editedAt) dto.editedAt = doc.editedAt.toISOString();
  if (doc.deletedAt) dto.deletedAt = doc.deletedAt.toISOString();
  if (doc.deletedBy) dto.deletedBy = doc.deletedBy.toString();
  if (doc.deletionReason) dto.deletionReason = doc.deletionReason;
  return dto;
};

export const Message: Model<MessageDocument> =
  (mongoose.models.Message as Model<MessageDocument>) ||
  mongoose.model<MessageDocument>('Message', messageSchema);
