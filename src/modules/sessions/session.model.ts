import mongoose, { Schema, type Model, type Types } from 'mongoose';

export const SESSION_REVOKED_REASON = {
  LOGOUT: 'logout',
  LOGOUT_ALL: 'logout_all',
  ROTATED: 'rotated',
  REUSED: 'reused',
  PASSWORD_CHANGE: 'password_change'
} as const;

export type SessionRevokedReason =
  (typeof SESSION_REVOKED_REASON)[keyof typeof SESSION_REVOKED_REASON];

export interface SessionAttrs {
  userId: Types.ObjectId;
  refreshTokenHash: string;
  userAgent?: string;
  ipAddress?: string;
  expiresAt: Date;
  revokedAt?: Date;
  revokedReason?: SessionRevokedReason;
  replacedBySessionId?: Types.ObjectId;
  rotatedAt: Date;
}

export interface SessionDocument extends SessionAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    refreshTokenHash: { type: String, required: true, index: true },
    userAgent: { type: String, maxlength: 500 },
    ipAddress: { type: String, maxlength: 64 },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: {
      type: String,
      enum: Object.values(SESSION_REVOKED_REASON)
    },
    replacedBySessionId: { type: Schema.Types.ObjectId, ref: 'Session' },
    rotatedAt: { type: Date, required: true, default: () => new Date() }
  },
  { timestamps: true, strict: 'throw' }
);

// TTL: Mongo auto-removes documents once expiresAt passes. Keeps the
// sessions collection bounded without a separate cleanup job.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session: Model<SessionDocument> =
  (mongoose.models.Session as Model<SessionDocument>) ||
  mongoose.model<SessionDocument>('Session', sessionSchema);
