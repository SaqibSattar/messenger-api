import type { Permission, Role } from '../permissions/permissions.constants';

export const USER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DEACTIVATED: 'deactivated'
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

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
