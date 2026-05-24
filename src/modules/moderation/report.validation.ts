import { z } from 'zod';
import {
  LIST_REPORTS_DEFAULT_LIMIT,
  LIST_REPORTS_MAX_LIMIT,
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_STATUS,
  REPORT_TARGET_TYPES,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType
} from './report.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Strip control / invisible / BiDi codepoints from the free-text details so
// crafted reports cannot smuggle invisible payloads to reviewers' tools. Same
// rule we use for display names and group titles.
const CONTROL_AND_INVISIBLE = new RegExp(
  '[' +
    '\\u0000-\\u001F' +
    '\\u007F-\\u009F' +
    '\\u200B-\\u200F' +
    '\\u2028-\\u2029' +
    '\\u202A-\\u202E' +
    '\\u2060-\\u2064' +
    '\\uFEFF' +
    ']',
  'g'
);

const normalizeDetails = (s: string): string =>
  s.normalize('NFKC').replace(CONTROL_AND_INVISIBLE, '').trim();

const detailsSchema = z
  .string()
  .min(1)
  .max(REPORT_DETAILS_MAX_LENGTH)
  .transform(normalizeDetails)
  .refine((v) => v.length >= 1, 'Details cannot be empty after normalization');

export const reportIdParamSchema = z
  .object({ reportId: objectIdSchema })
  .strict();

export const createReportSchema = z
  .object({
    targetType: z.enum(
      REPORT_TARGET_TYPES as readonly [
        ReportTargetType,
        ...ReportTargetType[]
      ]
    ),
    targetId: objectIdSchema,
    reason: z.enum(
      REPORT_REASONS as readonly [ReportReason, ...ReportReason[]]
    ),
    details: detailsSchema.optional()
  })
  .strict();

// Reviewers can only move forward through the lifecycle. Reopen is not
// exposed — keeps the audit chain append-only. The service double-checks the
// transition matrix because the input enum is only the *terminal* values.
export const updateReportStatusSchema = z
  .object({
    status: z.enum([
      REPORT_STATUS.REVIEWING,
      REPORT_STATUS.RESOLVED,
      REPORT_STATUS.DISMISSED
    ] as readonly [ReportStatus, ...ReportStatus[]]),
    note: z.string().trim().min(1).max(REPORT_DETAILS_MAX_LENGTH).optional()
  })
  .strict();

export const listReportsQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_REPORTS_MAX_LIMIT)
      .default(LIST_REPORTS_DEFAULT_LIMIT),
    status: z
      .enum(
        REPORT_TARGET_TYPES.length
          ? ([
              REPORT_STATUS.OPEN,
              REPORT_STATUS.REVIEWING,
              REPORT_STATUS.RESOLVED,
              REPORT_STATUS.DISMISSED
            ] as readonly [ReportStatus, ...ReportStatus[]])
          : ([REPORT_STATUS.OPEN] as readonly [ReportStatus, ...ReportStatus[]])
      )
      .optional(),
    targetType: z
      .enum(
        REPORT_TARGET_TYPES as readonly [
          ReportTargetType,
          ...ReportTargetType[]
        ]
      )
      .optional(),
    // Reporters can ask for "only mine"; reviewers use it to scope the queue.
    mine: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .transform((v) => v === true || v === 'true')
      .optional()
  })
  .strict();

export type CreateReportInput = z.infer<typeof createReportSchema>;
export type UpdateReportStatusInput = z.infer<typeof updateReportStatusSchema>;
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;
