import type { ConversationDto } from '../conversations/conversation.types';
import type { MessageDto } from '../messages/message.types';
import type { PublicUserDto } from '../users/user.types';

// Conservative bounds. The query text is run through a regex on Mongo, so
// pathological inputs (very long strings, repeated special characters) get
// truncated server-side regardless of what the client sends. 2 is the
// minimum because single-character queries return huge result sets on any
// reasonably populated database — we'd rather reject than degrade.
export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 100;

// Pagination caps. Search uses cursor pagination like the rest of the API.
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

export interface SearchConversationsResult {
  items: ConversationDto[];
  nextCursor: string | null;
}

// A message search result carries the parent conversation id so a client
// can render "in #group-x" and jump to the message in context. The message
// DTO itself already includes conversationId; we still surface this at the
// top level so the result is self-contained.
export interface MessageSearchHit {
  message: MessageDto;
  conversationId: string;
}

export interface SearchMessagesResult {
  items: MessageSearchHit[];
  nextCursor: string | null;
}

export interface SearchUsersResult {
  items: PublicUserDto[];
}
