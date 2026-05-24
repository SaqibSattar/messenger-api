import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  AUDIT_TARGET_TYPES,
  type AuditLogDto,
  type AuditTargetType
} from './auditLog.types';

export interface AuditLogAttrs {
  // `actorId` is optional because some audit events are recorded with no
  // authenticated actor (e.g. a failed login attempt). The action field is
  // always required so consumers can rely on it for filtering.
  actorId?: Types.ObjectId;
  action: string;
  targetType?: AuditTargetType;
  // Stored as a string rather than ObjectId because the audit log spans many
  // collections and a single ObjectId ref does not capture which collection
  // the target belongs to. `targetType` disambiguates.
  targetId?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogDocument extends AuditLogAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<AuditLogDocument>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true, maxlength: 100, index: true },
    targetType: { type: String, enum: AUDIT_TARGET_TYPES },
    targetId: { type: String, maxlength: 64 },
    requestId: { type: String, maxlength: 64 },
    ipAddress: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 500 },
    // Sanitised by the service before write — never accept raw caller input
    // here. `strict: false` on this field accepts an arbitrary JSON blob; the
    // parent schema is `strict: throw` so unknown top-level fields still fail.
    metadata: { type: Schema.Types.Mixed }
  },
  { timestamps: true, strict: 'throw' }
);

// Primary admin-facing query: "latest audit events, newest first" — possibly
// scoped by actor, action, or target.
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const toAuditLogDto = (doc: AuditLogDocument): AuditLogDto => {
  const dto: AuditLogDto = {
    id: (doc._id as Types.ObjectId).toString(),
    action: doc.action,
    createdAt: doc.createdAt.toISOString()
  };
  if (doc.actorId) dto.actorId = doc.actorId.toString();
  if (doc.targetType) dto.targetType = doc.targetType;
  if (doc.targetId) dto.targetId = doc.targetId;
  if (doc.requestId) dto.requestId = doc.requestId;
  if (doc.ipAddress) dto.ipAddress = doc.ipAddress;
  if (doc.userAgent) dto.userAgent = doc.userAgent;
  if (doc.metadata && Object.keys(doc.metadata).length > 0) {
    dto.metadata = { ...doc.metadata };
  }
  return dto;
};

export const AuditLog: Model<AuditLogDocument> =
  (mongoose.models.AuditLog as Model<AuditLogDocument>) ||
  mongoose.model<AuditLogDocument>('AuditLog', auditLogSchema);
