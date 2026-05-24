import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  ATTACHMENT_STATUS,
  ATTACHMENT_VISIBILITY,
  type AttachmentDto,
  type AttachmentStatus,
  type AttachmentVisibility
} from './media.types';

export interface AttachmentAttrs {
  ownerId: Types.ObjectId;
  conversationId?: Types.ObjectId;
  messageId?: Types.ObjectId;
  storageProvider: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  visibility: AttachmentVisibility;
  width?: number;
  height?: number;
  durationSeconds?: number;
  checksumSha256?: string;
  deletedAt?: Date;
  deletedBy?: Types.ObjectId;
}

export interface AttachmentDocument extends AttachmentAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const attachmentSchema = new Schema<AttachmentDocument>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    storageProvider: { type: String, required: true, trim: true },
    // Server-generated. Never built from client-supplied filenames so a
    // crafted filename can't traverse buckets or shadow another object.
    storageKey: { type: String, required: true, trim: true },
    originalFilename: { type: String, required: true, trim: true, maxlength: 512 },
    mimeType: { type: String, required: true, trim: true, lowercase: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: Object.values(ATTACHMENT_STATUS),
      default: ATTACHMENT_STATUS.PENDING,
      required: true
    },
    visibility: {
      type: String,
      enum: Object.values(ATTACHMENT_VISIBILITY),
      default: ATTACHMENT_VISIBILITY.PRIVATE,
      required: true
    },
    width: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    durationSeconds: { type: Number, min: 0 },
    checksumSha256: { type: String, trim: true, lowercase: true },
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true, strict: 'throw' }
);

// Storage keys are generated server-side and must be unique across the bucket
// — the unique index prevents a collision from ever producing two attachments
// pointing at the same underlying object.
attachmentSchema.index({ storageKey: 1 }, { unique: true });

// "My attachments" / "owner's pending uploads" lookups.
attachmentSchema.index({ ownerId: 1, status: 1, _id: -1 });

// Conversation-attached lookups (member listing of media in a chat).
attachmentSchema.index(
  { conversationId: 1, _id: -1 },
  { partialFilterExpression: { conversationId: { $type: 'objectId' } } }
);

// Message-attached lookups (rebuilding a message's attachment list).
attachmentSchema.index(
  { messageId: 1 },
  { partialFilterExpression: { messageId: { $type: 'objectId' } } }
);

// Orphan cleanup query: pending attachments older than the TTL whose owner
// never called /complete. Sparse so non-pending docs stay out of the index.
attachmentSchema.index(
  { status: 1, createdAt: 1 },
  { partialFilterExpression: { status: ATTACHMENT_STATUS.PENDING } }
);

export const toAttachmentDto = (doc: AttachmentDocument): AttachmentDto => {
  const dto: AttachmentDto = {
    id: (doc._id as Types.ObjectId).toString(),
    ownerId: doc.ownerId.toString(),
    storageProvider: doc.storageProvider,
    storageKey: doc.storageKey,
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    visibility: doc.visibility,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
  if (doc.conversationId) dto.conversationId = doc.conversationId.toString();
  if (doc.messageId) dto.messageId = doc.messageId.toString();
  if (doc.width != null) dto.width = doc.width;
  if (doc.height != null) dto.height = doc.height;
  if (doc.durationSeconds != null) dto.durationSeconds = doc.durationSeconds;
  if (doc.checksumSha256) dto.checksumSha256 = doc.checksumSha256;
  if (doc.deletedAt) dto.deletedAt = doc.deletedAt.toISOString();
  return dto;
};

export const Attachment: Model<AttachmentDocument> =
  (mongoose.models.Attachment as Model<AttachmentDocument>) ||
  mongoose.model<AttachmentDocument>('Attachment', attachmentSchema);
