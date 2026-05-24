import { z } from 'zod';
import {
  LIST_ACTIONS_DEFAULT_LIMIT,
  LIST_ACTIONS_MAX_LIMIT,
  MODERATION_ACTION_TYPES,
  MODERATION_REASON_MAX_LENGTH,
  MODERATION_TARGET_TYPES,
  type ModerationActionType,
  type ModerationTargetType
} from './moderation.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Metadata is a free-form bag for the moderator's tooling. We cap each key
// and value length so a runaway client cannot stash megabytes of trailing
// data on every action.
const METADATA_MAX_KEYS = 16;
const METADATA_KEY_MAX_LENGTH = 64;
const METADATA_VALUE_MAX_LENGTH = 500;

const metadataSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(METADATA_KEY_MAX_LENGTH)
      .regex(
        /^[A-Za-z0-9_.-]+$/,
        'Metadata keys may only contain letters, numbers, _, ., -'
      ),
    z.union([
      z.string().max(METADATA_VALUE_MAX_LENGTH),
      z.number(),
      z.boolean(),
      z.null()
    ])
  )
  .refine(
    (obj) => Object.keys(obj).length <= METADATA_MAX_KEYS,
    `Metadata may not have more than ${METADATA_MAX_KEYS} keys`
  );

export const createModerationActionSchema = z
  .object({
    actionType: z.enum(
      MODERATION_ACTION_TYPES as readonly [
        ModerationActionType,
        ...ModerationActionType[]
      ]
    ),
    targetType: z.enum(
      MODERATION_TARGET_TYPES as readonly [
        ModerationTargetType,
        ...ModerationTargetType[]
      ]
    ),
    targetId: objectIdSchema,
    reason: z.string().trim().min(1).max(MODERATION_REASON_MAX_LENGTH),
    metadata: metadataSchema.optional(),
    relatedReportId: objectIdSchema.optional()
  })
  .strict();

export const listModerationActionsQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_ACTIONS_MAX_LIMIT)
      .default(LIST_ACTIONS_DEFAULT_LIMIT),
    targetType: z
      .enum(
        MODERATION_TARGET_TYPES as readonly [
          ModerationTargetType,
          ...ModerationTargetType[]
        ]
      )
      .optional(),
    targetId: objectIdSchema.optional(),
    moderatorId: objectIdSchema.optional()
  })
  .strict()
  .refine(
    (data) => !(data.targetId && !data.targetType),
    'targetType is required when targetId is provided'
  );

export type CreateModerationActionInput = z.infer<
  typeof createModerationActionSchema
>;
export type ListModerationActionsQuery = z.infer<
  typeof listModerationActionsQuerySchema
>;
