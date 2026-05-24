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
  MODERATOR_DELETED: 'moderator_deleted'
} as const;

export type MessageDeletionReason =
  (typeof MESSAGE_DELETION_REASON)[keyof typeof MESSAGE_DELETION_REASON];

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  // null when the message has been deleted — the original body stays in the
  // DB for moderation/audit but is never returned to API clients.
  text: string | null;
  replyToMessageId?: string;
  editedAt?: string;
  deletedAt?: string;
  deletedBy?: string;
  deletionReason?: MessageDeletionReason;
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
