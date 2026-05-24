// Story / status post product rules and DTOs.
//
// Defaults follow the conservative profile from prompt 07b:
//   - lifetime: 24h
//   - audience: contacts (only people in the author's contacts)
//   - blocked users can never view each other's stories
//   - story owner can see viewer list; non-owners cannot
//
// The `contacts` audience leans on a contacts module that lands in prompt 13.
// Until then the call site is stubbed so the moderation/contacts modules can
// swap the implementation without changing this file.

export const STORY_AUDIENCE_TYPES = [
  'contacts',
  'everyone',
  'selected',
  'except'
] as const;
export type StoryAudienceType = (typeof STORY_AUDIENCE_TYPES)[number];

export const STORY_DELETION_REASON = {
  USER_DELETED: 'user_deleted',
  MODERATOR_REMOVED: 'moderator_removed',
  EXPIRED: 'expired'
} as const;
export type StoryDeletionReason =
  (typeof STORY_DELETION_REASON)[keyof typeof STORY_DELETION_REASON];

export const STORY_REPORT_REASONS = [
  'spam',
  'harassment',
  'hate_speech',
  'sexual_content',
  'violence',
  'self_harm',
  'misinformation',
  'other'
] as const;
export type StoryReportReason = (typeof STORY_REPORT_REASONS)[number];

// Hard caps to keep payloads bounded. Tune these only with product input.
export const STORY_TEXT_MAX_LENGTH = 700;
export const STORY_DEFAULT_LIFETIME_SECONDS = 24 * 60 * 60;
export const STORY_MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
export const STORY_MIN_LIFETIME_SECONDS = 60 * 60;
// Per-author live-story ceiling. A spam wave that bypasses rate-limits cannot
// quietly accumulate hundreds of posts.
export const STORY_MAX_ACTIVE_PER_USER = 30;
// Bounded media list per story. Most clients only attach 1-3; the cap
// prevents an attacker from forcing the story service into a wide media
// resolution pass.
export const STORY_MAX_MEDIA_PER_STORY = 5;
// Size cap for selected/excluded audience lists. The largest sensible
// "selected friends" list is below this; "except" is also bounded so a
// malicious caller can't push the whole user base into the document.
export const STORY_AUDIENCE_LIST_MAX = 500;
export const STORY_LIST_DEFAULT_LIMIT = 20;
export const STORY_LIST_MAX_LIMIT = 50;
export const STORY_VIEWERS_LIST_DEFAULT_LIMIT = 30;
export const STORY_VIEWERS_LIST_MAX_LIMIT = 100;
export const STORY_REPORT_DETAILS_MAX_LENGTH = 500;
// Batch size for the expiration sweep. Keeps each tick cheap and bounded.
export const STORY_EXPIRATION_BATCH_SIZE = 200;

export interface StoryMediaSummary {
  attachmentId: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  // Short-lived signed download URL. Only included when the viewer is
  // authorized for this story; never in list responses where the viewer hasn't
  // explicitly opened the story.
  downloadUrl?: string;
  downloadUrlExpiresAt?: string;
}

export interface StoryDto {
  id: string;
  authorId: string;
  text?: string;
  media: StoryMediaSummary[];
  audienceType: StoryAudienceType;
  // selectedUserIds / excludedUserIds are visible only to the story owner.
  // For non-owners they are redacted so the audience list itself does not
  // leak who is or isn't on the friends list.
  selectedUserIds?: string[];
  excludedUserIds?: string[];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  deletionReason?: StoryDeletionReason;
  // True if the requester is the story author.
  viewerIsAuthor?: boolean;
  // True if the requester already marked this story viewed.
  viewerHasViewed?: boolean;
  // Total viewer count. Only populated for the owner.
  viewerCount?: number;
}

export interface StoryViewerDto {
  viewerId: string;
  viewedAt: string;
}

export interface StoryListResult {
  items: StoryDto[];
  nextCursor: string | null;
}

export interface StoryViewersListResult {
  items: StoryViewerDto[];
  nextCursor: string | null;
}

export interface StoryMuteDto {
  userId: string;
  mutedUserId: string;
  createdAt: string;
}
