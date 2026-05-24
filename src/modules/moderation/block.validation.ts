import { z } from 'zod';
import {
  BLOCK_REASON_MAX_LENGTH,
  LIST_BLOCKS_DEFAULT_LIMIT,
  LIST_BLOCKS_MAX_LIMIT
} from './block.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

export const blockedUserIdParamSchema = z
  .object({ blockedUserId: objectIdSchema })
  .strict();

export const createBlockSchema = z
  .object({
    blockedUserId: objectIdSchema,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(BLOCK_REASON_MAX_LENGTH)
      .optional()
  })
  .strict();

export const listBlocksQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_BLOCKS_MAX_LIMIT)
      .default(LIST_BLOCKS_DEFAULT_LIMIT)
  })
  .strict();

export type CreateBlockInput = z.infer<typeof createBlockSchema>;
export type ListBlocksQuery = z.infer<typeof listBlocksQuerySchema>;
