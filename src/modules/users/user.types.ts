import type { Role } from '../permissions/permissions.constants';

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
  status: UserStatus;
  emailVerifiedAt?: string;
  phoneVerifiedAt?: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}
