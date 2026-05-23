import mongoose, { Schema, type Model } from 'mongoose';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { USER_STATUS, type UserDto, type UserStatus } from './user.types';

export interface UserAttrs {
  email?: string;
  phone?: string;
  passwordHash: string;
  displayName: string;
  avatarUrl?: string;
  role: Role;
  status: UserStatus;
  emailVerifiedAt?: Date;
  phoneVerifiedAt?: Date;
  lastLoginAt?: Date;
  passwordChangedAt?: Date;
}

export interface UserDocument extends UserAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

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
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },
    avatarUrl: { type: String, trim: true },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.MEMBER,
      required: true
    },
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.ACTIVE,
      required: true
    },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
    lastLoginAt: { type: Date },
    passwordChangedAt: { type: Date, select: false }
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

export const toUserDto = (user: UserDocument): UserDto => {
  const dto: UserDto = {
    id: (user._id as mongoose.Types.ObjectId).toString(),
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString()
  };
  if (user.email) dto.email = user.email;
  if (user.phone) dto.phone = user.phone;
  if (user.avatarUrl) dto.avatarUrl = user.avatarUrl;
  if (user.emailVerifiedAt)
    dto.emailVerifiedAt = user.emailVerifiedAt.toISOString();
  if (user.phoneVerifiedAt)
    dto.phoneVerifiedAt = user.phoneVerifiedAt.toISOString();
  if (user.lastLoginAt) dto.lastLoginAt = user.lastLoginAt.toISOString();
  return dto;
};

export const User: Model<UserDocument> =
  (mongoose.models.User as Model<UserDocument>) ||
  mongoose.model<UserDocument>('User', userSchema);
