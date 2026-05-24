import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  QUIET_HOURS_MINUTES_PER_DAY,
  QUIET_HOURS_TIMEZONE_MAX_LENGTH,
  type NotificationPreferencesDto,
  type QuietHoursDto
} from './notification.types';

export interface QuietHoursAttrs {
  startMinute: number;
  endMinute: number;
  timezone: string;
}

export interface NotificationPreferenceAttrs {
  userId: Types.ObjectId;
  pushEnabled: boolean;
  emailEnabled: boolean;
  messagePreviewEnabled: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  quietHours?: QuietHoursAttrs;
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

const quietHoursSchema = new Schema<QuietHoursAttrs>(
  {
    startMinute: {
      type: Number,
      required: true,
      min: 0,
      max: QUIET_HOURS_MINUTES_PER_DAY - 1
    },
    endMinute: {
      type: Number,
      required: true,
      min: 0,
      max: QUIET_HOURS_MINUTES_PER_DAY - 1
    },
    timezone: {
      type: String,
      required: true,
      maxlength: QUIET_HOURS_TIMEZONE_MAX_LENGTH
    }
  },
  { _id: false }
);

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
      soundEnabled: {
        type: Boolean,
        default: DEFAULT_NOTIFICATION_PREFERENCES.soundEnabled,
        required: true
      },
      vibrationEnabled: {
        type: Boolean,
        default: DEFAULT_NOTIFICATION_PREFERENCES.vibrationEnabled,
        required: true
      },
      quietHours: { type: quietHoursSchema, required: false },
      mutedConversationIds: {
        type: [{ type: Schema.Types.ObjectId, ref: 'Conversation' }],
        default: []
      }
    },
    { timestamps: true, strict: 'throw' }
  );

const toQuietHoursDto = (qh: QuietHoursAttrs | undefined): QuietHoursDto | undefined => {
  if (!qh) return undefined;
  return {
    startMinute: qh.startMinute,
    endMinute: qh.endMinute,
    timezone: qh.timezone
  };
};

export const toNotificationPreferencesDto = (
  doc: NotificationPreferenceDocument
): NotificationPreferencesDto => {
  const dto: NotificationPreferencesDto = {
    pushEnabled: doc.pushEnabled,
    emailEnabled: doc.emailEnabled,
    messagePreviewEnabled: doc.messagePreviewEnabled,
    soundEnabled: doc.soundEnabled,
    vibrationEnabled: doc.vibrationEnabled,
    mutedConversationIds: (doc.mutedConversationIds ?? []).map((id) =>
      id.toString()
    )
  };
  const qh = toQuietHoursDto(doc.quietHours);
  if (qh) dto.quietHours = qh;
  return dto;
};

export const NotificationPreference: Model<NotificationPreferenceDocument> =
  (mongoose.models.NotificationPreference as Model<NotificationPreferenceDocument>) ||
  mongoose.model<NotificationPreferenceDocument>(
    'NotificationPreference',
    notificationPreferenceSchema
  );
