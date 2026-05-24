import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  NOTIFICATION_BODY_PREVIEW_MAX_LENGTH,
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_TITLE_MAX_LENGTH,
  NOTIFICATION_TYPES,
  type NotificationDto,
  type NotificationEntityType,
  type NotificationType
} from './notification.types';

export interface NotificationAttrs {
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  bodyPreview?: string;
  entityType?: NotificationEntityType;
  entityId?: Types.ObjectId;
  conversationId?: Types.ObjectId;
  data?: Record<string, unknown>;
  readAt?: Date;
}

export interface NotificationDocument
  extends NotificationAttrs,
    mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<NotificationDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    type: {
      type: String,
      enum: [...NOTIFICATION_TYPES],
      required: true
    },
    // Title is a short, server-built string — clients render it directly.
    // Length cap prevents a malicious caller (or a future bug) from blowing
    // up the inbox row size.
    title: {
      type: String,
      required: true,
      maxlength: NOTIFICATION_TITLE_MAX_LENGTH
    },
    bodyPreview: {
      type: String,
      maxlength: NOTIFICATION_BODY_PREVIEW_MAX_LENGTH
    },
    entityType: {
      type: String,
      enum: [...NOTIFICATION_ENTITY_TYPES]
    },
    // entityId is intentionally untyped (no ref) because notifications can
    // point at messages, conversations, reports, moderation actions, or
    // users. The entityType field disambiguates.
    entityId: { type: Schema.Types.ObjectId },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation'
    },
    // Shallow JSON. Stored as Mixed so the controller layer can pass small
    // metadata bags without us having to model every variant — but strict
    // mode at the parent level keeps the rest of the schema honest.
    data: { type: Schema.Types.Mixed },
    readAt: { type: Date }
  },
  { timestamps: true, strict: 'throw' }
);

// Primary inbox query: "notifications for this user, newest first". _id is
// time-ordered so we cursor by _id rather than maintaining a separate
// createdAt index.
notificationSchema.index({ userId: 1, _id: -1 });

// Unread count: sparse partial index that only contains rows where readAt
// is missing. Keeps the index tiny — a user with 10k read notifications
// still only carries the unread tail in this index.
notificationSchema.index(
  { userId: 1, readAt: 1 },
  { partialFilterExpression: { readAt: { $exists: false } } }
);

export const toNotificationDto = (
  doc: NotificationDocument
): NotificationDto => {
  const dto: NotificationDto = {
    id: (doc._id as Types.ObjectId).toString(),
    userId: doc.userId.toString(),
    type: doc.type,
    title: doc.title,
    createdAt: doc.createdAt.toISOString()
  };
  if (doc.bodyPreview) dto.bodyPreview = doc.bodyPreview;
  if (doc.entityType) dto.entityType = doc.entityType;
  if (doc.entityId) dto.entityId = doc.entityId.toString();
  if (doc.conversationId) dto.conversationId = doc.conversationId.toString();
  if (doc.data && Object.keys(doc.data).length > 0) {
    // Spread to drop any internal Mongoose markers and ensure we hand back
    // a plain JSON-safe object.
    dto.data = { ...doc.data };
  }
  if (doc.readAt) dto.readAt = doc.readAt.toISOString();
  return dto;
};

export const Notification: Model<NotificationDocument> =
  (mongoose.models.Notification as Model<NotificationDocument>) ||
  mongoose.model<NotificationDocument>('Notification', notificationSchema);
