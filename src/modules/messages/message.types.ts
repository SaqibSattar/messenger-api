// Hard limit on plain-text message body. 4000 keeps a single message well
// inside the global 100kb JSON body cap even when fully filled, and matches
// the spec line "store message text as plain text by default".
export const MESSAGE_TEXT_MAX_LENGTH = 4000;

// Used to build conversation.lastMessage.preview. Server-side truncation is
// mandatory: the conversation document is read in inbox listings and must
// never carry the full body.
export const MESSAGE_PREVIEW_MAX_LENGTH = 120;

export const LIST_MESSAGES_DEFAULT_LIMIT = 30;
export const LIST_MESSAGES_MAX_LIMIT = 100;

// Reactions are a single user-visible glyph or short ZWJ sequence. The byte
// length cap (after NFKC + invisible-stripping) blocks abuse via tens of
// thousand-char "emoji" strings while staying generous enough for legitimate
// composed emoji (e.g. flag + skin tone). Keep in sync with the validator.
export const REACTION_EMOJI_MAX_LENGTH = 32;

export const MESSAGE_DELETION_REASON = {
  USER_DELETED: 'user_deleted',
  MODERATOR_DELETED: 'moderator_deleted',
  EXPIRED: 'expired'
} as const;

export type MessageDeletionReason =
  (typeof MESSAGE_DELETION_REASON)[keyof typeof MESSAGE_DELETION_REASON];

// Source of `expiresAt`. Only `send_time` is implemented today — `read_time`
// is stubbed so the field can change later without a migration.
export const MESSAGE_EXPIRATION_POLICY = {
  SEND_TIME: 'send_time'
} as const;

export type MessageExpirationPolicy =
  (typeof MESSAGE_EXPIRATION_POLICY)[keyof typeof MESSAGE_EXPIRATION_POLICY];

// Default cleanup batch size and idle interval. Kept small so a sweep on a
// single instance never holds a long-running cursor; production tuning can
// override via env later.
export const DISAPPEARING_CLEANUP_BATCH_SIZE = 200;

// Lean attachment shape embedded in a message DTO. The full attachment can
// still be fetched via /api/v1/media/:id when the client needs a download
// URL — keeping this minimal avoids bloating the message payload on lists.
export interface MessageAttachmentSummary {
  id: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  // null when the message has been deleted OR expired — the original body
  // stays in the DB for moderation/audit but is never returned to API clients.
  text: string | null;
  attachments?: MessageAttachmentSummary[];
  replyToMessageId?: string;
  editedAt?: string;
  deletedAt?: string;
  deletedBy?: string;
  deletionReason?: MessageDeletionReason;
  expiresAt?: string;
  expiredAt?: string;
  expirationPolicy?: MessageExpirationPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface MessageReceiptDto {
  id: string;
  messageId: string;
  userId: string;
  deliveredAt?: string;
  readAt?: string;
}

export interface MessageReactionDto {
  id: string;
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: string;
}

export interface ListMessagesResult {
  items: MessageDto[];
  nextCursor: string | null;
}
