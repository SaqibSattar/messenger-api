export const BLOCK_REASON_MAX_LENGTH = 280;

export const LIST_BLOCKS_DEFAULT_LIMIT = 25;
export const LIST_BLOCKS_MAX_LIMIT = 100;

export interface BlockDto {
  id: string;
  blockerId: string;
  blockedUserId: string;
  reason?: string;
  createdAt: string;
}

export interface BlockedUserSummaryDto {
  id: string;
  username?: string;
  displayName: string;
  avatarUrl?: string;
}

export interface BlockListItemDto {
  block: BlockDto;
  blockedUser: BlockedUserSummaryDto;
}
