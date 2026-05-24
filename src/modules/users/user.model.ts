import mongoose, { Schema, type Model } from 'mongoose';
import {
  ALL_PERMISSIONS,
  ROLES,
  type Permission,
  type Role
} from '../permissions/permissions.constants';
import {
  DEFAULT_PRIVACY_SETTINGS,
  PRIVACY_AUDIENCES,
  USER_STATUS,
  type PrivacySettings,
  type PublicUserDto,
  type UserDto,
  type UserStatus
} from './user.types';

export interface UserAttrs {
  email?: string;
  phone?: string;
  username?: string;
  passwordHash: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  role: Role;
  customPermissions: Permission[];
  status: UserStatus;
  privacySettings: PrivacySettings;
  emailVerifiedAt?: Date;
  phoneVerifiedAt?: Date;
  lastLoginAt?: Date;
  passwordChangedAt?: Date;
  deactivatedAt?: Date;
  // Deletion lifecycle. `deletionRequestedAt` and `deletionScheduledFor` are
  // set when the user calls /me/delete-request and cleared by /me/delete-cancel.
  // `deletedAt` is stamped by the finalization job when status flips to
  // DELETED, at which point the document has been anonymized.
  deletionRequestedAt?: Date;
  deletionScheduledFor?: Date;
  deletedAt?: Date;
}

export interface UserDocument extends UserAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const privacySchema = new Schema<PrivacySettings>(
  {
    discoverableByEmail: { type: Boolean, default: true },
    discoverableByPhone: { type: Boolean, default: true },
    discoverableByUsername: { type: Boolean, default: true },
    showLastSeen: { type: Boolean, default: true },
    showOnlineStatus: { type: Boolean, default: true },
    whoCanFindMe: {
      type: String,
      enum: [...PRIVACY_AUDIENCES],
      default: DEFAULT_PRIVACY_SETTINGS.whoCanFindMe
    },
    whoCanMessageMe: {
      type: String,
      enum: [...PRIVACY_AUDIENCES],
      default: DEFAULT_PRIVACY_SETTINGS.whoCanMessageMe
    },
    readReceiptsEnabled: {
      type: Boolean,
      default: DEFAULT_PRIVACY_SETTINGS.readReceiptsEnabled
    },
    onlineStatusVisibility: {
      type: String,
      enum: [...PRIVACY_AUDIENCES],
      default: DEFAULT_PRIVACY_SETTINGS.onlineStatusVisibility
    },
    profilePhotoVisibility: {
      type: String,
      enum: [...PRIVACY_AUDIENCES],
      default: DEFAULT_PRIVACY_SETTINGS.profilePhotoVisibility
    }
  },
  { _id: false }
);

const userSchema = new Schema<UserDocument>(
  {
    email: {
      type: String,
      lowercase: true,
      trim: true,
      index: { unique: true, sparse: true }
    },
    phone: {
      type: String,
      trim: true,
      index: { unique: true, sparse: true }
    },
    username: {
      type: String,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      index: { unique: true, sparse: true }
    },
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },
    avatarUrl: { type: String, trim: true, maxlength: 2048 },
    bio: { type: String, trim: true, maxlength: 280 },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.MEMBER,
      required: true
    },
    customPermissions: {
      type: [
        {
          type: String,
          enum: [...ALL_PERMISSIONS]
        }
      ],
      default: []
    },
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.ACTIVE,
      required: true
    },
    privacySettings: {
      type: privacySchema,
      default: () => ({ ...DEFAULT_PRIVACY_SETTINGS })
    },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
    lastLoginAt: { type: Date },
    passwordChangedAt: { type: Date, select: false },
    deactivatedAt: { type: Date },
    deletionRequestedAt: { type: Date },
    deletionScheduledFor: { type: Date, index: true },
    deletedAt: { type: Date }
  },
  { timestamps: true, strict: 'throw' }
);

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    delete out.passwordHash;
    delete out.passwordChangedAt;
    delete out.__v;
    return out;
  }
});

const resolvePrivacy = (user: UserDocument): PrivacySettings => {
  // user.privacySettings is a Mongoose subdocument; spread it as a plain
  // object so the DTO does not leak `$__`, `_doc`, etc.
  const stored = (user.privacySettings as unknown) as
    | (PrivacySettings & { toObject?: () => PrivacySettings })
    | undefined;
  const plain = stored?.toObject ? stored.toObject() : stored;
  return {
    discoverableByEmail:
      plain?.discoverableByEmail ?? DEFAULT_PRIVACY_SETTINGS.discoverableByEmail,
    discoverableByPhone:
      plain?.discoverableByPhone ?? DEFAULT_PRIVACY_SETTINGS.discoverableByPhone,
    discoverableByUsername:
      plain?.discoverableByUsername ??
      DEFAULT_PRIVACY_SETTINGS.discoverableByUsername,
    showLastSeen:
      plain?.showLastSeen ?? DEFAULT_PRIVACY_SETTINGS.showLastSeen,
    showOnlineStatus:
      plain?.showOnlineStatus ?? DEFAULT_PRIVACY_SETTINGS.showOnlineStatus,
    whoCanFindMe:
      plain?.whoCanFindMe ?? DEFAULT_PRIVACY_SETTINGS.whoCanFindMe,
    whoCanMessageMe:
      plain?.whoCanMessageMe ?? DEFAULT_PRIVACY_SETTINGS.whoCanMessageMe,
    readReceiptsEnabled:
      plain?.readReceiptsEnabled ??
      DEFAULT_PRIVACY_SETTINGS.readReceiptsEnabled,
    onlineStatusVisibility:
      plain?.onlineStatusVisibility ??
      DEFAULT_PRIVACY_SETTINGS.onlineStatusVisibility,
    profilePhotoVisibility:
      plain?.profilePhotoVisibility ??
      DEFAULT_PRIVACY_SETTINGS.profilePhotoVisibility
  };
};

export const resolvePrivacySettings = resolvePrivacy;

export const toUserDto = (user: UserDocument): UserDto => {
  const dto: UserDto = {
    id: (user._id as mongoose.Types.ObjectId).toString(),
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    privacySettings: resolvePrivacy(user),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString()
  };
  if (user.email) dto.email = user.email;
  if (user.phone) dto.phone = user.phone;
  if (user.username) dto.username = user.username;
  if (user.avatarUrl) dto.avatarUrl = user.avatarUrl;
  if (user.bio) dto.bio = user.bio;
  if (user.customPermissions && user.customPermissions.length > 0) {
    dto.customPermissions = [...user.customPermissions];
  }
  if (user.emailVerifiedAt)
    dto.emailVerifiedAt = user.emailVerifiedAt.toISOString();
  if (user.phoneVerifiedAt)
    dto.phoneVerifiedAt = user.phoneVerifiedAt.toISOString();
  if (user.lastLoginAt) dto.lastLoginAt = user.lastLoginAt.toISOString();
  if (user.deactivatedAt) dto.deactivatedAt = user.deactivatedAt.toISOString();
  if (user.deletionRequestedAt)
    dto.deletionRequestedAt = user.deletionRequestedAt.toISOString();
  if (user.deletionScheduledFor)
    dto.deletionScheduledFor = user.deletionScheduledFor.toISOString();
  if (user.deletedAt) dto.deletedAt = user.deletedAt.toISOString();
  return dto;
};

// Lean projection safe to expose to other users. Must never include email,
// phone, role, status, privacy settings, or any login/activity metadata.
export const toPublicUserDto = (user: UserDocument): PublicUserDto => {
  const dto: PublicUserDto = {
    id: (user._id as mongoose.Types.ObjectId).toString(),
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString()
  };
  if (user.username) dto.username = user.username;
  if (user.avatarUrl) dto.avatarUrl = user.avatarUrl;
  if (user.bio) dto.bio = user.bio;
  return dto;
};

export const User: Model<UserDocument> =
  (mongoose.models.User as Model<UserDocument>) ||
  mongoose.model<UserDocument>('User', userSchema);
