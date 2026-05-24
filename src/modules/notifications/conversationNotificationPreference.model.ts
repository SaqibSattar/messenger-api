import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { ConversationNotificationPreferenceDto } from './notification.types';

// Per-conversation push override. Kept separate from ConversationMember so
// the inbox-side state (mute previews, archive, lastReadMessageId) and the
// push-side state (mute push fan-out, mention-only) can evolve independently
// and so a user who isn't actively in a conversation can still hold a stored
// preference for it (e.g. after leaving and rejoining).
export interface ConversationNotificationPreferenceAttrs {
  userId: Types.ObjectId;
  conversationId: Types.ObjectId;
  // When set and in the future, push fan-out for this conversation is
  // suppressed. Inbox rows are still written so the user can scroll back.
  mutedUntil?: Date;
  // When true, push fan-out is suppressed for ordinary messages but still
  // fires for messages that explicitly mention the user (mention support
  // lands in a later module — this flag is honored as a no-op for plain
  // messages today).
  mentionOnly: boolean;
}

export interface ConversationNotificationPreferenceDocument
  extends ConversationNotificationPreferenceAttrs,
    mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const conversationNotificationPreferenceSchema =
  new Schema<ConversationNotificationPreferenceDocument>(
    {
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
      },
      conversationId: {
        type: Schema.Types.ObjectId,
        ref: 'Conversation',
        required: true
      },
      mutedUntil: { type: Date },
      mentionOnly: { type: Boolean, default: false, required: true }
    },
    { timestamps: true, strict: 'throw' }
  );

// One preference row per (user, conversation). Lookups are always on this
// pair — the push worker reads it for every recipient before fan-out.
conversationNotificationPreferenceSchema.index(
  { userId: 1, conversationId: 1 },
  { unique: true }
);

export const toConversationNotificationPreferenceDto = (
  doc: ConversationNotificationPreferenceDocument
): ConversationNotificationPreferenceDto => {
  const dto: ConversationNotificationPreferenceDto = {
    conversationId: doc.conversationId.toString(),
    mentionOnly: doc.mentionOnly
  };
  if (doc.mutedUntil) dto.mutedUntil = doc.mutedUntil.toISOString();
  return dto;
};

export const ConversationNotificationPreference: Model<ConversationNotificationPreferenceDocument> =
  (mongoose.models
    .ConversationNotificationPreference as Model<ConversationNotificationPreferenceDocument>) ||
  mongoose.model<ConversationNotificationPreferenceDocument>(
    'ConversationNotificationPreference',
    conversationNotificationPreferenceSchema
  );
