import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferencesDto
} from './notification.types';

export interface NotificationPreferenceAttrs {
  userId: Types.ObjectId;
  pushEnabled: boolean;
  emailEnabled: boolean;
  messagePreviewEnabled: boolean;
  // Conversations the user has explicitly muted at the notification layer.
  // Distinct from ConversationMember.mutedUntil which mutes inbox previews —
  // this list controls push fan-out specifically.
  mutedConversationIds: Types.ObjectId[];
}

export interface NotificationPreferenceDocument
  extends NotificationPreferenceAttrs,
    mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const notificationPreferenceSchema =
  new Schema<NotificationPreferenceDocument>(
    {
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: { unique: true }
      },
      pushEnabled: {
        type: Boolean,
        default: DEFAULT_NOTIFICATION_PREFERENCES.pushEnabled,
        required: true
      },
      emailEnabled: {
        type: Boolean,
        default: DEFAULT_NOTIFICATION_PREFERENCES.emailEnabled,
        required: true
      },
      messagePreviewEnabled: {
        type: Boolean,
        default: DEFAULT_NOTIFICATION_PREFERENCES.messagePreviewEnabled,
        required: true
      },
      mutedConversationIds: {
        type: [{ type: Schema.Types.ObjectId, ref: 'Conversation' }],
        default: []
      }
    },
    { timestamps: true, strict: 'throw' }
  );

export const toNotificationPreferencesDto = (
  doc: NotificationPreferenceDocument
): NotificationPreferencesDto => ({
  pushEnabled: doc.pushEnabled,
  emailEnabled: doc.emailEnabled,
  messagePreviewEnabled: doc.messagePreviewEnabled,
  mutedConversationIds: (doc.mutedConversationIds ?? []).map((id) =>
    id.toString()
  )
});

export const NotificationPreference: Model<NotificationPreferenceDocument> =
  (mongoose.models.NotificationPreference as Model<NotificationPreferenceDocument>) ||
  mongoose.model<NotificationPreferenceDocument>(
    'NotificationPreference',
    notificationPreferenceSchema
  );
