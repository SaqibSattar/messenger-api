import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { ContactDto } from './contact.types';

export interface ContactAttrs {
  userId: Types.ObjectId;
  contactUserId: Types.ObjectId;
}

export interface ContactDocument extends ContactAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new Schema<ContactDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    contactUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }
  },
  { timestamps: true, strict: 'throw' }
);

// One contact row per (owner, contact) ordered pair. Pairs are stored as two
// directed rows (see contact.types.ts) — the uniqueness is per row, not per
// undirected pair.
contactSchema.index({ userId: 1, contactUserId: 1 }, { unique: true });

// Reverse lookup: "who has X as a contact?" — used when X removes the
// account so we can cascade.
contactSchema.index({ contactUserId: 1 });

export const toContactDto = (doc: ContactDocument): ContactDto => ({
  id: (doc._id as Types.ObjectId).toString(),
  userId: doc.userId.toString(),
  contactUserId: doc.contactUserId.toString(),
  createdAt: doc.createdAt.toISOString()
});

export const Contact: Model<ContactDocument> =
  (mongoose.models.Contact as Model<ContactDocument>) ||
  mongoose.model<ContactDocument>('Contact', contactSchema);
