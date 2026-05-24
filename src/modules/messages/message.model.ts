import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  MESSAGE_DELETION_REASON,
  MESSAGE_EXPIRATION_POLICY,
  type MessageAttachmentSummary,
  type MessageDeletionReason,
  type MessageDto,
  type MessageExpirationPolicy
} from './message.types';

export interface MessageAttrs {
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  text: string;
  // Attachment ObjectIds set when the message is created with media. The
  // media module owns the lifecycle; here we only store the references.
  attachments: Types.ObjectId[];
  replyToMessageId?: Types.ObjectId;
  editedAt?: Date;
  deletedAt?: Date;
  deletedBy?: Types.ObjectId;
  deletionReason?: MessageDeletionReason;
  // Disappearing message bookkeeping. `expiresAt` is set when the message is
  // created in a conversation that has disappearing messages enabled; the
  // cleanup job redacts the body and stamps `expiredAt` once that time passes.
  expiresAt?: Date;
  expiredAt?: Date;
  expirationPolicy?: MessageExpirationPolicy;
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
    // `required: true` would reject empty strings, which we need to write
    // when a message is expired/redacted by the cleanup job. Send-time
    // validation already rejects empty input via Zod (see message.validation),
    // so storing '' is only ever reachable through deliberate redaction.
    text: { type: String, default: '' },
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
    },
    expiresAt: { type: Date },
    expiredAt: { type: Date },
    expirationPolicy: {
      type: String,
      enum: Object.values(MESSAGE_EXPIRATION_POLICY)
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

// Cleanup job query: messages that are scheduled to expire. Sparse keeps
// non-expiring messages out of the index entirely. We cannot narrow further
// with a partial filter on `expiredAt: { $exists: false }` — MongoDB only
// allows positive existence checks in partial filter expressions — so the
// cleanup job adds the `expiredAt` filter at query time.
messageSchema.index({ expiresAt: 1 }, { sparse: true });

export const toMessageDto = (
  doc: MessageDocument,
  attachments?: MessageAttachmentSummary[]
): MessageDto => {
  const id = (doc._id as Types.ObjectId).toString();
  // A message is considered redacted-from-clients if it's deleted, has been
  // processed by the expiration job, OR is past its expiresAt window but the
  // job hasn't run yet. The last case is the load-bearing one: clients must
  // not see plaintext for an "expired but uncleaned" message, even if a read
  // races the cleanup sweep.
  const isExpired =
    !!doc.expiredAt ||
    (!!doc.expiresAt && doc.expiresAt.getTime() <= Date.now());
  const isRedacted = !!doc.deletedAt || isExpired;
  const dto: MessageDto = {
    id,
    conversationId: doc.conversationId.toString(),
    senderId: doc.senderId.toString(),
    text: isRedacted ? null : doc.text,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
  // Attachments are dropped from the DTO when the message is redacted so an
  // expired body doesn't continue to leak media to clients. The underlying
  // attachment lifecycle is managed by the media module; the message DTO
  // simply doesn't surface them once the parent message is gone.
  if (!isRedacted && attachments && attachments.length > 0) {
    dto.attachments = attachments;
  }
  if (doc.replyToMessageId) {
    dto.replyToMessageId = doc.replyToMessageId.toString();
  }
  if (doc.editedAt) dto.editedAt = doc.editedAt.toISOString();
  if (doc.deletedAt) dto.deletedAt = doc.deletedAt.toISOString();
  if (doc.deletedBy) dto.deletedBy = doc.deletedBy.toString();
  if (doc.deletionReason) dto.deletionReason = doc.deletionReason;
  if (doc.expiresAt) dto.expiresAt = doc.expiresAt.toISOString();
  if (doc.expiredAt) dto.expiredAt = doc.expiredAt.toISOString();
  if (doc.expirationPolicy) dto.expirationPolicy = doc.expirationPolicy;
  return dto;
};

export const Message: Model<MessageDocument> =
  (mongoose.models.Message as Model<MessageDocument>) ||
  mongoose.model<MessageDocument>('Message', messageSchema);
