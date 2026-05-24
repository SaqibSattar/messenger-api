import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  CONTACT_REQUEST_MESSAGE_MAX_LENGTH,
  CONTACT_REQUEST_STATUS,
  CONTACT_REQUEST_STATUSES,
  type ContactRequestDto,
  type ContactRequestStatus
} from './contact.types';

export interface ContactRequestAttrs {
  senderId: Types.ObjectId;
  receiverId: Types.ObjectId;
  status: ContactRequestStatus;
  message?: string;
  respondedAt?: Date;
}

export interface ContactRequestDocument
  extends ContactRequestAttrs,
    mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const contactRequestSchema = new Schema<ContactRequestDocument>(
  {
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    receiverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    status: {
      type: String,
      enum: [...CONTACT_REQUEST_STATUSES],
      default: CONTACT_REQUEST_STATUS.PENDING,
      required: true
    },
    // Optional sender-supplied note. Kept short and plain — XSS protection is
    // the responsibility of the renderer, but we still strip control chars in
    // the validator before persisting.
    message: {
      type: String,
      trim: true,
      maxlength: CONTACT_REQUEST_MESSAGE_MAX_LENGTH
    },
    respondedAt: { type: Date }
  },
  { timestamps: true, strict: 'throw' }
);

// At most one PENDING request per (sender, receiver) ordered pair. Older
// historical rows in a terminal state (accepted / declined / cancelled) stay
// in the collection and don't block a fresh request — that's the load-bearing
// behavior the partial filter expression enforces.
contactRequestSchema.index(
  { senderId: 1, receiverId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: CONTACT_REQUEST_STATUS.PENDING }
  }
);

// List "incoming requests for me" / "outgoing requests by me" by status.
contactRequestSchema.index({ receiverId: 1, status: 1, _id: -1 });
contactRequestSchema.index({ senderId: 1, status: 1, _id: -1 });

export const toContactRequestDto = (
  doc: ContactRequestDocument
): ContactRequestDto => {
  const dto: ContactRequestDto = {
    id: (doc._id as Types.ObjectId).toString(),
    senderId: doc.senderId.toString(),
    receiverId: doc.receiverId.toString(),
    status: doc.status,
    createdAt: doc.createdAt.toISOString()
  };
  if (doc.message) dto.message = doc.message;
  if (doc.respondedAt) dto.respondedAt = doc.respondedAt.toISOString();
  return dto;
};

export const ContactRequest: Model<ContactRequestDocument> =
  (mongoose.models.ContactRequest as Model<ContactRequestDocument>) ||
  mongoose.model<ContactRequestDocument>(
    'ContactRequest',
    contactRequestSchema
  );
