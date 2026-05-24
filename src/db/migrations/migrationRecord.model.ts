import mongoose, { Schema, type Model } from 'mongoose';
import type { MigrationRecordShape } from './types';

export interface MigrationRecordDocument
  extends MigrationRecordShape,
    mongoose.Document {}

const migrationRecordSchema = new Schema<MigrationRecordDocument>(
  {
    name: { type: String, required: true },
    appliedAt: { type: Date, required: true, default: () => new Date() },
    durationMs: { type: Number, required: true, min: 0 }
  },
  // No timestamps — `appliedAt` already captures the only fact we need,
  // and a `createdAt` would be confusing alongside it.
  { strict: 'throw', versionKey: false }
);

// The idempotency guarantee: a second attempt to record the same migration
// name fails with a duplicate-key error, which the runner catches and
// treats as "already applied".
migrationRecordSchema.index({ name: 1 }, { unique: true });

export const MigrationRecord: Model<MigrationRecordDocument> =
  (mongoose.models.MigrationRecord as Model<MigrationRecordDocument>) ||
  mongoose.model<MigrationRecordDocument>(
    'MigrationRecord',
    migrationRecordSchema
  );
