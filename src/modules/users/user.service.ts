import argon2 from 'argon2';
import mongoose, { type FilterQuery } from 'mongoose';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError
} from '../../utils/errors';
import {
  Session,
  SESSION_REVOKED_REASON
} from '../sessions/session.model';
import {
  User,
  toPublicUserDto,
  toUserDto,
  type UserDocument
} from './user.model';
import {
  DEFAULT_PRIVACY_SETTINGS,
  USER_STATUS,
  type PrivacySettings,
  type PublicUserDto,
  type UserDto
} from './user.types';
import type {
  DeactivateAccountInput,
  SearchUsersInput,
  UpdateProfileInput
} from './user.validation';

const ALLOWED_DISCOVERABILITY_FIELDS = new Set([
  'discoverableByEmail',
  'discoverableByPhone',
  'discoverableByUsername',
  'showLastSeen',
  'showOnlineStatus'
] as const);

const findActiveUser = async (
  filter: FilterQuery<UserDocument>
): Promise<UserDocument | null> => {
  return User.findOne({ ...filter, status: USER_STATUS.ACTIVE });
};

const mergePrivacySettings = (
  existing: PrivacySettings | undefined,
  patch: Partial<PrivacySettings>
): PrivacySettings => {
  const base: PrivacySettings = { ...DEFAULT_PRIVACY_SETTINGS, ...existing };
  for (const [key, value] of Object.entries(patch)) {
    // Defense in depth: ignore any field that isn't an allowed privacy flag.
    if (ALLOWED_DISCOVERABILITY_FIELDS.has(key as keyof PrivacySettings)) {
      (base as unknown as Record<string, boolean>)[key] = Boolean(value);
    }
  }
  return base;
};

export const getMe = async (userId: string): Promise<UserDto> => {
  const user = await User.findById(userId);
  if (!user) throw new UnauthorizedError();
  return toUserDto(user);
};

export const updateMe = async (
  userId: string,
  input: UpdateProfileInput
): Promise<UserDto> => {
  const user = await User.findById(userId);
  if (!user) throw new UnauthorizedError();

  if (input.displayName !== undefined) {
    user.displayName = input.displayName;
  }
  if (input.username !== undefined) {
    user.username = input.username;
  }
  if (input.bio !== undefined) {
    // Empty bio means "clear it" — model field is optional.
    user.bio = input.bio.length > 0 ? input.bio : undefined;
  }
  if (input.avatarUrl !== undefined) {
    user.avatarUrl = input.avatarUrl ?? undefined;
  }
  if (input.privacySettings !== undefined) {
    user.privacySettings = mergePrivacySettings(
      user.privacySettings,
      input.privacySettings
    );
  }

  try {
    await user.save();
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      // Username (or email/phone via a future flow) collided. Generic message
      // to avoid leaking which value is taken.
      throw new ConflictError('Profile could not be updated');
    }
    throw err;
  }
  return toUserDto(user);
};

export const getPublicProfile = async (
  userId: string
): Promise<PublicUserDto> => {
  const user = await findActiveUser({ _id: userId });
  if (!user) throw new NotFoundError('User not found');
  return toPublicUserDto(user);
};

// Search rules:
//   - exact match only (no regex / substring) to prevent enumeration
//   - returns at most one record (email/phone/username are unique)
//   - honors the target's privacy settings: if the matching field is not
//     discoverable, behave as if the user does not exist
//   - never reveal email/phone/role/status/privacy via the response shape;
//     always return the public DTO
export const searchUsers = async (
  input: SearchUsersInput
): Promise<PublicUserDto[]> => {
  let user: UserDocument | null = null;
  let discoverable = false;

  if (input.email) {
    user = await findActiveUser({ email: input.email });
    discoverable = user?.privacySettings?.discoverableByEmail ?? true;
  } else if (input.phone) {
    user = await findActiveUser({ phone: input.phone });
    discoverable = user?.privacySettings?.discoverableByPhone ?? true;
  } else if (input.username) {
    user = await findActiveUser({ username: input.username });
    discoverable = user?.privacySettings?.discoverableByUsername ?? true;
  }

  if (!user || !discoverable) return [];
  return [toPublicUserDto(user)];
};

export const deactivateAccount = async (
  userId: string,
  input: DeactivateAccountInput
): Promise<void> => {
  // Require password confirmation: a stolen access token alone must not be
  // enough to kill an account.
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new UnauthorizedError();

  const valid = await argon2.verify(user.passwordHash, input.password);
  if (!valid) throw new UnauthorizedError('Password is incorrect');

  user.status = USER_STATUS.DEACTIVATED;
  user.deactivatedAt = new Date();
  await user.save();

  await Session.updateMany(
    { userId: user._id, revokedAt: { $exists: false } },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: SESSION_REVOKED_REASON.LOGOUT_ALL
      }
    }
  );
};
