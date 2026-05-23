import type { Permission, Role } from '../permissions/permissions.constants';

export const USER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DEACTIVATED: 'deactivated'
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export interface UserDto {
  id: string;
  email?: string;
  phone?: string;
  displayName: string;
  avatarUrl?: string;
  role: Role;
  // Only included when the user has any custom permission overrides — keeping
  // it absent on the common case avoids leaking the permission shape and keeps
  // payloads small.
  customPermissions?: Permission[];
  status: UserStatus;
  emailVerifiedAt?: string;
  phoneVerifiedAt?: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}
