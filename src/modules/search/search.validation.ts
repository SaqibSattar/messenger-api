import { z } from 'zod';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH
} from './search.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Strip everything Mongo $regex would interpret beyond literal text, plus
// the same control/zero-width/BiDi-override invisible set the rest of the
// codebase rejects. The trimmed, normalized string is what we hand to the
// service — never the raw client input.
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

const normalizeQuery = (s: string): string =>
  s
    .normalize('NFKC')
    .replace(CONTROL_AND_INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();

// `q` is the user's search string. Length cap is applied AFTER normalization
// so a query padded with whitespace can't sneak past the limit.
const searchQuerySchema = z
  .string()
  .max(SEARCH_QUERY_MAX_LENGTH * 4) // pre-normalize cap (generous, then re-checked)
  .transform(normalizeQuery)
  .refine(
    (v) => v.length >= SEARCH_QUERY_MIN_LENGTH,
    `Query must be at least ${SEARCH_QUERY_MIN_LENGTH} characters`
  )
  .refine(
    (v) => v.length <= SEARCH_QUERY_MAX_LENGTH,
    `Query must be at most ${SEARCH_QUERY_MAX_LENGTH} characters`
  );

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(SEARCH_MAX_LIMIT)
  .default(SEARCH_DEFAULT_LIMIT);

export const searchConversationsQuerySchema = z
  .object({
    q: searchQuerySchema,
    cursor: objectIdSchema.optional(),
    limit: limitSchema
  })
  .strict();

// `conversationId` restricts message search to a single conversation. Without
// it, search runs across all the user's conversations.
export const searchMessagesQuerySchema = z
  .object({
    q: searchQuerySchema,
    conversationId: objectIdSchema.optional(),
    cursor: objectIdSchema.optional(),
    limit: limitSchema
  })
  .strict();

export const searchUsersQuerySchema = z
  .object({
    q: searchQuerySchema,
    limit: limitSchema
  })
  .strict();

export type SearchConversationsQuery = z.infer<
  typeof searchConversationsQuerySchema
>;
export type SearchMessagesQuery = z.infer<typeof searchMessagesQuerySchema>;
export type SearchUsersQuery = z.infer<typeof searchUsersQuerySchema>;
