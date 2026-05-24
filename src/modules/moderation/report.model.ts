import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_STATUS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  type ReportDto,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType
} from './report.types';

export interface ReportAttrs {
  reporterId: Types.ObjectId;
  targetType: ReportTargetType;
  targetId: Types.ObjectId;
  reason: ReportReason;
  details?: string;
  status: ReportStatus;
  assignedTo?: Types.ObjectId;
  resolvedAt?: Date;
}

export interface ReportDocument extends ReportAttrs, mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<ReportDocument>(
  {
    reporterId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    targetType: {
      type: String,
      enum: REPORT_TARGET_TYPES,
      required: true
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: true
    },
    reason: {
      type: String,
      enum: REPORT_REASONS,
      required: true
    },
    details: {
      type: String,
      trim: true,
      maxlength: REPORT_DETAILS_MAX_LENGTH
    },
    status: {
      type: String,
      enum: REPORT_STATUSES,
      default: REPORT_STATUS.OPEN,
      required: true
    },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date }
  },
  { timestamps: true, strict: 'throw' }
);

// Reviewers paginate the queue by status + recency.
reportSchema.index({ status: 1, createdAt: -1 });
// Reporter's view of their own submissions.
reportSchema.index({ reporterId: 1, createdAt: -1 });
// Lookups during moderation: "all reports about this target".
reportSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const toReportDto = (doc: ReportDocument): ReportDto => {
  const dto: ReportDto = {
    id: (doc._id as Types.ObjectId).toString(),
    reporterId: doc.reporterId.toString(),
    targetType: doc.targetType,
    targetId: doc.targetId.toString(),
    reason: doc.reason,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
  if (doc.details) dto.details = doc.details;
  if (doc.assignedTo) dto.assignedTo = doc.assignedTo.toString();
  if (doc.resolvedAt) dto.resolvedAt = doc.resolvedAt.toISOString();
  return dto;
};

// Reporter-facing projection that masks the report body. The reporter already
// submitted the details, but other reviewers must not see them in passing
// listings — only when explicitly fetched.
export const toReporterListReportDto = (doc: ReportDocument): ReportDto => {
  const dto = toReportDto(doc);
  delete dto.details;
  return dto;
};

export const Report: Model<ReportDocument> =
  (mongoose.models.Report as Model<ReportDocument>) ||
  mongoose.model<ReportDocument>('Report', reportSchema);
