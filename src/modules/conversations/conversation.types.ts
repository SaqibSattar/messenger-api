export const CONVERSATION_TYPE = {
  DIRECT: 'direct',
  GROUP: 'group'
} as const;

export type ConversationType =
  (typeof CONVERSATION_TYPE)[keyof typeof CONVERSATION_TYPE];

export const CONVERSATION_MEMBER_ROLE = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member'
} as const;

export type ConversationMemberRole =
  (typeof CONVERSATION_MEMBER_ROLE)[keyof typeof CONVERSATION_MEMBER_ROLE];

export const GROUP_TITLE_MIN_LENGTH = 1;
export const GROUP_TITLE_MAX_LENGTH = 80;
// Hard upper bound on initial creation and post-create adds. Picked to keep
// fan-out predictable; raise deliberately if product needs larger groups.
export const GROUP_MAX_MEMBERS = 256;
// Conservative cap on a single add-members call so a moderator/admin can't
// blow past GROUP_MAX_MEMBERS in one request via a giant array.
export const ADD_MEMBERS_MAX_PER_REQUEST = 50;
export const LIST_CONVERSATIONS_DEFAULT_LIMIT = 20;
export const LIST_CONVERSATIONS_MAX_LIMIT = 50;

export const CONVERSATION_SETTINGS_WHO_CAN_SEND = ['all', 'admins'] as const;
export type WhoCanSendMessages =
  (typeof CONVERSATION_SETTINGS_WHO_CAN_SEND)[number];

export interface ConversationSettings {
  whoCanSendMessages: WhoCanSendMessages;
}

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  whoCanSendMessages: 'all'
};

export interface ConversationLastMessageDto {
  messageId: string;
  senderId: string;
  preview: string;
  sentAt: string;
}

export interface ConversationDto {
  id: string;
  type: ConversationType;
  title?: string;
  avatarUrl?: string;
  createdBy: string;
  lastMessage?: ConversationLastMessageDto;
  settings: ConversationSettings;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMemberDto {
  id: string;
  conversationId: string;
  userId: string;
  role: ConversationMemberRole;
  joinedAt: string;
  leftAt?: string;
  mutedUntil?: string;
  archivedAt?: string;
  lastReadMessageId?: string;
}

export interface MyConversationDto {
  conversation: ConversationDto;
  membership: ConversationMemberDto;
}
