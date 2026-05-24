import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  STORY_AUDIENCE_TYPES,
  STORY_DELETION_REASON,
  type StoryAudienceType,
  type StoryDeletionReason,
  type StoryDto
} from './story.types';

export interface StoryAttrs {
  authorId: Types.ObjectId;
  text?: string;
  mediaAttachmentIds: Types.ObjectId[];
  audienceType: StoryAudienceType;
  selectedUserIds: Types.ObjectId[];
  excludedUserIds: Types.ObjectId[];
  expiresAt: Date;
  deletedAt?: Date;
  deletedBy?: Types.ObjectId;
  deletionReason?: StoryDeletionReason;
}

export interface StoryDocument extends StoryAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const storySchema = new Schema<StoryDocument>(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, default: '' },
    mediaAttachmentIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Attachment' }],
      default: []
    },
    audienceType: {
      type: String,
      enum: [...STORY_AUDIENCE_TYPES],
      required: true
    },
    selectedUserIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    excludedUserIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    expiresAt: { type: Date, required: true },
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletionReason: {
      type: String,
      enum: Object.values(STORY_DELETION_REASON)
    }
  },
  { timestamps: true, strict: 'throw' }
);

// Primary listing path: stories from a given author, newest first. Combined
// with the expiry/deleted filters at the service layer.
// (Mongo provides the natural { _id: -1 } cursor on the default _id index.)
storySchema.index({ authorId: 1, _id: -1 });

// Expiration sweep: stories that have hit their TTL. The cleanup query
// adds the `deletedAt` filter at the service layer — MongoDB partial
// filter expressions only support positive existence checks, so we cannot
// narrow the index to "not deleted" directly.
storySchema.index({ expiresAt: 1 });

export const toStoryDto = (
  doc: StoryDocument,
  options: {
    viewerId: string;
    viewerHasViewed?: boolean;
    viewerCount?: number;
    media?: StoryDto['media'];
  }
): StoryDto => {
  const id = (doc._id as Types.ObjectId).toString();
  const authorId = doc.authorId.toString();
  const viewerIsAuthor = authorId === options.viewerId;
  const isRedacted = !!doc.deletedAt;

  const dto: StoryDto = {
    id,
    authorId,
    media: isRedacted ? [] : options.media ?? [],
    audienceType: doc.audienceType,
    expiresAt: doc.expiresAt.toISOString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    viewerIsAuthor,
    viewerHasViewed: options.viewerHasViewed ?? false
  };

  // Text is masked once the story is deleted/expired so a leaked id can't
  // surface plaintext after takedown.
  if (!isRedacted && doc.text && doc.text.length > 0) {
    dto.text = doc.text;
  }

  // Audience lists are private to the owner. Exposing them to other viewers
  // would leak the author's friends/exclusion list.
  if (viewerIsAuthor) {
    if (doc.selectedUserIds && doc.selectedUserIds.length > 0) {
      dto.selectedUserIds = doc.selectedUserIds.map((id) => id.toString());
    }
    if (doc.excludedUserIds && doc.excludedUserIds.length > 0) {
      dto.excludedUserIds = doc.excludedUserIds.map((id) => id.toString());
    }
    if (typeof options.viewerCount === 'number') {
      dto.viewerCount = options.viewerCount;
    }
  }

  if (doc.deletedAt) dto.deletedAt = doc.deletedAt.toISOString();
  if (doc.deletionReason) dto.deletionReason = doc.deletionReason;
  return dto;
};

export const Story: Model<StoryDocument> =
  (mongoose.models.Story as Model<StoryDocument>) ||
  mongoose.model<StoryDocument>('Story', storySchema);
