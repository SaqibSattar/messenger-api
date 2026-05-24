import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { StoryMuteDto } from './story.types';

export interface StoryMuteAttrs {
  userId: Types.ObjectId;
  mutedUserId: Types.ObjectId;
}

export interface StoryMuteDocument extends StoryMuteAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const storyMuteSchema = new Schema<StoryMuteDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mutedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true, strict: 'throw' }
);

// One mute relationship per (muter, muted) pair. The second POST /mutes from
// the same user against the same target is a no-op.
storyMuteSchema.index({ userId: 1, mutedUserId: 1 }, { unique: true });

// Listing path: "stories I can see" filters out authors I've muted, so the
// fast lookup is "all of my mutes" → set of ids to exclude.
storyMuteSchema.index({ userId: 1, _id: -1 });

export const toStoryMuteDto = (doc: StoryMuteDocument): StoryMuteDto => ({
  userId: doc.userId.toString(),
  mutedUserId: doc.mutedUserId.toString(),
  createdAt: doc.createdAt.toISOString()
});

export const StoryMute: Model<StoryMuteDocument> =
  (mongoose.models.StoryMute as Model<StoryMuteDocument>) ||
  mongoose.model<StoryMuteDocument>('StoryMute', storyMuteSchema);
