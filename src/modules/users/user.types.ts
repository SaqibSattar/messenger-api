import type { Permission, Role } from '../permissions/permissions.constants';

export const USER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DEACTIVATED: 'deactivated',
  // The user has submitted a delete-request and is inside the grace window.
  // Sessions and devices have been revoked; the account can still log in to
  // cancel deletion but is hidden from discovery and DM creation surfaces.
  PENDING_DELETION: 'pending_deletion',
  // Finalization has run. The user document is anonymized and login is
  // refused outright — only the stable `_id` is preserved so historical
  // conversations rendered by other participants still resolve.
  DELETED: 'deleted'
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

// Display name used on the user document after finalization. Read by client
// code via the public DTO; we keep the name here so a future locale-aware
// renderer can override it without searching the codebase.
export const DELETED_USER_DISPLAY_NAME = 'Deleted user';

// Visibility scope for privacy-sensitive surfaces.
// `everyone`  — any authenticated user
// `contacts`  — users who are confirmed contacts of the subject
// `nobody`    — nobody but the subject themselves
export const PRIVACY_AUDIENCE = {
  EVERYONE: 'everyone',
  CONTACTS: 'contacts',
  NOBODY: 'nobody'
} as const;

export type PrivacyAudience =
  (typeof PRIVACY_AUDIENCE)[keyof typeof PRIVACY_AUDIENCE];

export const PRIVACY_AUDIENCES: readonly PrivacyAudience[] =
  Object.values(PRIVACY_AUDIENCE);

export interface PrivacySettings {
  discoverableByEmail: boolean;
  discoverableByPhone: boolean;
  discoverableByUsername: boolean;
  showLastSeen: boolean;
  showOnlineStatus: boolean;
  // Audience-scoped controls (prompt 13).
  // whoCanFindMe  — gates surfacing in /search/users (text search) AND the
  //                 exact-match endpoints (search by email/phone/username).
  // whoCanMessageMe — gates direct conversation creation and direct messages.
  // onlineStatusVisibility / profilePhotoVisibility — surface-level gating in
  // public profile DTOs.
  // readReceiptsEnabled — a per-account opt-out the receipts module honors
  // when computing whether to write/return a `readAt` value.
  whoCanFindMe: PrivacyAudience;
  whoCanMessageMe: PrivacyAudience;
  readReceiptsEnabled: boolean;
  onlineStatusVisibility: PrivacyAudience;
  profilePhotoVisibility: PrivacyAudience;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  discoverableByEmail: true,
  discoverableByPhone: true,
  discoverableByUsername: true,
  showLastSeen: true,
  showOnlineStatus: true,
  whoCanFindMe: PRIVACY_AUDIENCE.EVERYONE,
  whoCanMessageMe: PRIVACY_AUDIENCE.EVERYONE,
  readReceiptsEnabled: true,
  onlineStatusVisibility: PRIVACY_AUDIENCE.EVERYONE,
  profilePhotoVisibility: PRIVACY_AUDIENCE.EVERYONE
};

export interface UserDto {
  id: string;
  email?: string;
  phone?: string;
  username?: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  role: Role;
  // Only included when the user has any custom permission overrides — keeping
  // it absent on the common case avoids leaking the permission shape and keeps
  // payloads small.
  customPermissions?: Permission[];
  status: UserStatus;
  privacySettings: PrivacySettings;
  emailVerifiedAt?: string;
  phoneVerifiedAt?: string;
  lastLoginAt?: string;
  deactivatedAt?: string;
  // Deletion-lifecycle fields. Surfaced to the owner so the client can render
  // a "your account is scheduled for deletion on …" banner and a cancel CTA.
  deletionRequestedAt?: string;
  deletionScheduledFor?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Minimal projection returned for any other user. Must never include email,
// phone, role, status, privacy, lastLoginAt, or anything that could enable
// enumeration or targeted abuse.
export interface PublicUserDto {
  id: string;
  username?: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  createdAt: string;
}
