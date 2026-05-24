import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  DEVICE_APP_VERSION_MAX_LENGTH,
  DEVICE_DEVICE_NAME_MAX_LENGTH,
  DEVICE_LOCALE_MAX_LENGTH,
  DEVICE_PLATFORMS,
  DEVICE_PUSH_PROVIDER,
  DEVICE_PUSH_PROVIDERS,
  DEVICE_PUSH_TOKEN_MAX_LENGTH,
  type DeviceDto,
  type DevicePlatform,
  type DevicePushProvider
} from './device.types';

export interface DeviceAttrs {
  userId: Types.ObjectId;
  platform: DevicePlatform;
  // Token issued by APNs/FCM/WebPush. Treated as a secret — never returned
  // in any DTO and never logged. Uniqueness across the collection keeps a
  // single physical device from being registered to multiple users (which
  // would mis-route push notifications after an account swap).
  pushToken: string;
  pushProvider: DevicePushProvider;
  deviceName?: string;
  appVersion?: string;
  locale?: string;
  lastSeenAt: Date;
  // Soft-revoke. The push fan-out worker skips any device with revokedAt
  // set, but we keep the row around so a user can see historical sign-ins.
  revokedAt?: Date;
}

export interface DeviceDocument extends DeviceAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const deviceSchema = new Schema<DeviceDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    platform: {
      type: String,
      enum: [...DEVICE_PLATFORMS],
      required: true
    },
    pushToken: {
      type: String,
      required: true,
      trim: true,
      maxlength: DEVICE_PUSH_TOKEN_MAX_LENGTH,
      // `select: false` so an accidental `.find()` from another module never
      // pulls the token into a response. Callers that need it must opt in
      // with `.select('+pushToken')`.
      select: false
    },
    pushProvider: {
      type: String,
      enum: [...DEVICE_PUSH_PROVIDERS],
      required: true,
      default: DEVICE_PUSH_PROVIDER.FCM
    },
    deviceName: {
      type: String,
      trim: true,
      maxlength: DEVICE_DEVICE_NAME_MAX_LENGTH
    },
    appVersion: {
      type: String,
      trim: true,
      maxlength: DEVICE_APP_VERSION_MAX_LENGTH
    },
    locale: {
      type: String,
      trim: true,
      maxlength: DEVICE_LOCALE_MAX_LENGTH
    },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    revokedAt: { type: Date }
  },
  { timestamps: true, strict: 'throw' }
);

// One push token per row globally. If the same physical device is registered
// to a second user the previous owner's row must be revoked first — the
// upsert path the device service owns enforces that explicitly.
deviceSchema.index({ pushToken: 1 }, { unique: true });

// Primary fan-out query: "all active devices for this user". Ordered by _id
// desc so the most-recently-registered device is the first push target.
deviceSchema.index({ userId: 1, _id: -1 });

// Audit / housekeeping: pruning stale devices that haven't checked in.
deviceSchema.index({ lastSeenAt: 1 });

export const toDeviceDto = (doc: DeviceDocument): DeviceDto => {
  const dto: DeviceDto = {
    id: (doc._id as Types.ObjectId).toString(),
    userId: doc.userId.toString(),
    platform: doc.platform,
    pushProvider: doc.pushProvider,
    lastSeenAt: doc.lastSeenAt.toISOString(),
    createdAt: doc.createdAt.toISOString()
  };
  if (doc.deviceName) dto.deviceName = doc.deviceName;
  if (doc.appVersion) dto.appVersion = doc.appVersion;
  if (doc.locale) dto.locale = doc.locale;
  if (doc.revokedAt) dto.revokedAt = doc.revokedAt.toISOString();
  return dto;
};

export const Device: Model<DeviceDocument> =
  (mongoose.models.Device as Model<DeviceDocument>) ||
  mongoose.model<DeviceDocument>('Device', deviceSchema);
