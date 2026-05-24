import type { Permission, Role } from '../permissions/permissions.constants';

export const USER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DEACTIVATED: 'deactivated'
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export interface PrivacySettings {
  discoverableByEmail: boolean;
  discoverableByPhone: boolean;
  discoverableByUsername: boolean;
  showLastSeen: boolean;
  showOnlineStatus: boolean;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  discoverableByEmail: true,
  discoverableByPhone: true,
  discoverableByUsername: true,
  showLastSeen: true,
  showOnlineStatus: true
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
