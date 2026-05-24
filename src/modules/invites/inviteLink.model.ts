import mongoose, { Schema, type Model, type Types } from 'mongoose';
import { INVITE_MIN_USES_LIMIT, type InviteLinkDto } from './invite.types';

export interface InviteLinkAttrs {
  conversationId: Types.ObjectId;
  createdBy: Types.ObjectId;
  // We persist only the SHA-256 hash of the token. The raw token is sent to
  // the creator at creation time and is never recoverable from the database.
  tokenHash: string;
  expiresAt?: Date;
  maxUses?: number;
  useCount: number;
  revokedAt?: Date;
}

export interface InviteLinkDocument extends InviteLinkAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const inviteLinkSchema = new Schema<InviteLinkDocument>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    tokenHash: {
      type: String,
      required: true,
      // tokenHash is the unique lookup key for "given a token, find the
      // invite". `unique` is enforced; the underlying SHA-256 collision
      // probability is negligible but the index still defends against bugs
      // where a regenerated token would otherwise silently overwrite.
      unique: true
    },
    expiresAt: { type: Date },
    maxUses: { type: Number, min: INVITE_MIN_USES_LIMIT },
    useCount: { type: Number, default: 0, min: 0, required: true },
    revokedAt: { type: Date }
  },
  { timestamps: true, strict: 'throw' }
);

// Listing/cleanup of "all invites for a conversation" — admins inspect or
// revoke from the conversation surface.
inviteLinkSchema.index({ conversationId: 1, _id: -1 });

// TTL-style cleanup is intentionally NOT a Mongo TTL index here. Expired
// invites stay in the collection so admins can audit who used them; the
// "is this invite active?" check is enforced at join time.

export const toInviteLinkDto = (doc: InviteLinkDocument): InviteLinkDto => {
  const dto: InviteLinkDto = {
    id: (doc._id as Types.ObjectId).toString(),
    conversationId: doc.conversationId.toString(),
    createdBy: doc.createdBy.toString(),
    useCount: doc.useCount,
    createdAt: doc.createdAt.toISOString()
  };
  if (doc.expiresAt) dto.expiresAt = doc.expiresAt.toISOString();
  if (typeof doc.maxUses === 'number') dto.maxUses = doc.maxUses;
  if (doc.revokedAt) dto.revokedAt = doc.revokedAt.toISOString();
  return dto;
};

export const InviteLink: Model<InviteLinkDocument> =
  (mongoose.models.InviteLink as Model<InviteLinkDocument>) ||
  mongoose.model<InviteLinkDocument>('InviteLink', inviteLinkSchema);
