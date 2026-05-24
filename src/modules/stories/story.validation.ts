import { z } from 'zod';
import {
  STORY_AUDIENCE_LIST_MAX,
  STORY_AUDIENCE_TYPES,
  STORY_DEFAULT_LIFETIME_SECONDS,
  STORY_LIST_DEFAULT_LIMIT,
  STORY_LIST_MAX_LIMIT,
  STORY_MAX_LIFETIME_SECONDS,
  STORY_MAX_MEDIA_PER_STORY,
  STORY_MIN_LIFETIME_SECONDS,
  STORY_REPORT_DETAILS_MAX_LENGTH,
  STORY_REPORT_REASONS,
  STORY_TEXT_MAX_LENGTH,
  STORY_VIEWERS_LIST_DEFAULT_LIMIT,
  STORY_VIEWERS_LIST_MAX_LIMIT
} from './story.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Strip the same invisible / BiDi / control characters we strip from
// conversation titles and message bodies. Stories are user-facing text just
// like messages, so a crafted caption shouldn't be able to homoglyph someone.
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

const normalizeText = (s: string): string =>
  s.normalize('NFKC').replace(CONTROL_AND_INVISIBLE, '').replace(/\s+/g, ' ').trim();

const textSchema = z
  .string()
  .max(STORY_TEXT_MAX_LENGTH)
  .transform(normalizeText);

const audienceIdListSchema = z
  .array(objectIdSchema)
  .max(STORY_AUDIENCE_LIST_MAX);

export const storyIdParamSchema = z
  .object({ storyId: objectIdSchema })
  .strict();

export const storyMuteParamSchema = z
  .object({ userId: objectIdSchema })
  .strict();

// Create-story input. Either `text` or at least one media attachment must be
// present — empty stories are rejected. The expiration window is bounded by
// the configured min/max so a caller can't extend a story for years or set a
// zero lifetime that bypasses the cleanup job.
export const createStorySchema = z
  .object({
    text: textSchema.optional(),
    mediaAttachmentIds: z
      .array(objectIdSchema)
      .max(STORY_MAX_MEDIA_PER_STORY)
      .optional(),
    audienceType: z.enum(STORY_AUDIENCE_TYPES).default('contacts'),
    selectedUserIds: audienceIdListSchema.optional(),
    excludedUserIds: audienceIdListSchema.optional(),
    lifetimeSeconds: z
      .number()
      .int()
      .min(STORY_MIN_LIFETIME_SECONDS)
      .max(STORY_MAX_LIFETIME_SECONDS)
      .default(STORY_DEFAULT_LIFETIME_SECONDS)
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasText = !!data.text && data.text.length > 0;
    const hasMedia =
      Array.isArray(data.mediaAttachmentIds) &&
      data.mediaAttachmentIds.length > 0;
    if (!hasText && !hasMedia) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Story must include text or at least one media attachment'
      });
    }

    if (
      data.audienceType === 'selected' &&
      (!data.selectedUserIds || data.selectedUserIds.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedUserIds'],
        message: 'selectedUserIds is required when audienceType is "selected"'
      });
    }

    if (data.audienceType !== 'selected' && data.selectedUserIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedUserIds'],
        message: 'selectedUserIds is only allowed when audienceType is "selected"'
      });
    }

    if (
      data.audienceType === 'except' &&
      (!data.excludedUserIds || data.excludedUserIds.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['excludedUserIds'],
        message: 'excludedUserIds is required when audienceType is "except"'
      });
    }

    if (data.audienceType !== 'except' && data.excludedUserIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['excludedUserIds'],
        message: 'excludedUserIds is only allowed when audienceType is "except"'
      });
    }

    // Dedup inside selected/excluded so a duplicated id doesn't artificially
    // inflate the size against the cap and so the stored list is canonical.
    if (data.selectedUserIds) {
      const uniq = new Set(data.selectedUserIds);
      if (uniq.size !== data.selectedUserIds.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selectedUserIds'],
          message: 'selectedUserIds must not contain duplicates'
        });
      }
    }
    if (data.excludedUserIds) {
      const uniq = new Set(data.excludedUserIds);
      if (uniq.size !== data.excludedUserIds.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['excludedUserIds'],
          message: 'excludedUserIds must not contain duplicates'
        });
      }
    }

    if (data.mediaAttachmentIds) {
      const uniq = new Set(data.mediaAttachmentIds);
      if (uniq.size !== data.mediaAttachmentIds.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mediaAttachmentIds'],
          message: 'mediaAttachmentIds must not contain duplicates'
        });
      }
    }
  });

export const listStoriesQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(STORY_LIST_MAX_LIMIT)
      .default(STORY_LIST_DEFAULT_LIMIT),
    // Owner-scoped feed: "my own active stories" when true.
    onlyMine: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .transform((v) => v === true || v === 'true')
      .default(false)
  })
  .strict();

export const listStoryViewersQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(STORY_VIEWERS_LIST_MAX_LIMIT)
      .default(STORY_VIEWERS_LIST_DEFAULT_LIMIT)
  })
  .strict();

export const reportStorySchema = z
  .object({
    reason: z.enum(STORY_REPORT_REASONS),
    details: z
      .string()
      .max(STORY_REPORT_DETAILS_MAX_LENGTH)
      .transform(normalizeText)
      .optional()
  })
  .strict();

export const createStoryMuteSchema = z
  .object({
    mutedUserId: objectIdSchema
  })
  .strict();

export type CreateStoryInput = z.infer<typeof createStorySchema>;
export type ListStoriesQuery = z.infer<typeof listStoriesQuerySchema>;
export type ListStoryViewersQuery = z.infer<
  typeof listStoryViewersQuerySchema
>;
export type ReportStoryInput = z.infer<typeof reportStorySchema>;
export type CreateStoryMuteInput = z.infer<typeof createStoryMuteSchema>;

export const __storyValidationInternals = { normalizeText };
