// Invite-link types for group conversations.
//
// An invite token is presented in the URL/body by a joiner; the server only
// stores its SHA-256 hash (not the plaintext) so a database leak doesn't
// hand over working invite links. Tokens are generated with crypto.randomBytes
// so they are unguessable in the spec's threat model.

export const INVITE_TOKEN_BYTES = 24; // 192 bits of randomness
// URL-safe encoding length for INVITE_TOKEN_BYTES base64url-encoded.
// 24 bytes -> 32 chars (no padding). Used as the upper bound when validating
// inbound tokens.
export const INVITE_TOKEN_MAX_LENGTH = 64;
export const INVITE_TOKEN_MIN_LENGTH = 16;

// Default cap on how many active (non-revoked, non-expired, under maxUses)
// invite links can exist for a single conversation at one time. Prevents an
// admin from creating thousands of links accidentally and turning the
// collection into a moderation liability.
export const INVITE_MAX_ACTIVE_PER_CONVERSATION = 10;

// Default lifetime when the creator does not specify expiresAt. Keeps the
// surface area for stale links bounded.
export const INVITE_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const INVITE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

export const INVITE_MAX_USES_LIMIT = 1000;
export const INVITE_MIN_USES_LIMIT = 1;

export interface InviteLinkDto {
  id: string;
  conversationId: string;
  createdBy: string;
  expiresAt?: string;
  maxUses?: number;
  useCount: number;
  revokedAt?: string;
  createdAt: string;
}

// Returned ONLY on creation. The raw token is the secret the creator passes
// to their joiners; the server never re-emits it because only the hash is
// stored.
export interface InviteLinkWithTokenDto extends InviteLinkDto {
  token: string;
}

export interface JoinByInviteResultDto {
  conversationId: string;
  membershipId: string;
}
