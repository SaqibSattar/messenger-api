import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { StoryViewerDto } from './story.types';

export interface StoryViewAttrs {
  storyId: Types.ObjectId;
  viewerId: Types.ObjectId;
  viewedAt: Date;
}

export interface StoryViewDocument extends StoryViewAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const storyViewSchema = new Schema<StoryViewDocument>(
  {
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', required: true },
    viewerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    viewedAt: { type: Date, required: true, default: () => new Date() }
  },
  { timestamps: true, strict: 'throw' }
);

// One view per (story, viewer) — the second POST /view from the same user is
// a no-op upsert, not a duplicate row. Without this index we'd inflate
// viewer counts and leak repeat-viewing patterns to the owner.
storyViewSchema.index({ storyId: 1, viewerId: 1 }, { unique: true });

// Viewer list pagination cursor: ordered by viewedAt desc (most recent
// viewers first), tiebroken by _id so the cursor is stable.
storyViewSchema.index({ storyId: 1, viewedAt: -1, _id: -1 });

export const toStoryViewerDto = (
  doc: StoryViewDocument
): StoryViewerDto => ({
  viewerId: doc.viewerId.toString(),
  viewedAt: doc.viewedAt.toISOString()
});

export const StoryView: Model<StoryViewDocument> =
  (mongoose.models.StoryView as Model<StoryViewDocument>) ||
  mongoose.model<StoryViewDocument>('StoryView', storyViewSchema);
