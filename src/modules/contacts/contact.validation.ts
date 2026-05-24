import { z } from 'zod';
import {
  CONTACT_REQUEST_MESSAGE_MAX_LENGTH,
  LIST_CONTACT_REQUESTS_DEFAULT_LIMIT,
  LIST_CONTACT_REQUESTS_MAX_LIMIT,
  LIST_CONTACTS_DEFAULT_LIMIT,
  LIST_CONTACTS_MAX_LIMIT
} from './contact.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Strip control / zero-width / BiDi-override chars from messages so a hostile
// sender cannot pass a homoglyph payload that renders different from what
// the receiver expects. Mirrors the user-bio sanitization in user.validation.
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

const normalizeMessage = (s: string): string =>
  s.normalize('NFKC').replace(CONTROL_AND_INVISIBLE, '').replace(/\s+/g, ' ').trim();

const messageSchema = z
  .string()
  .max(CONTACT_REQUEST_MESSAGE_MAX_LENGTH)
  .transform(normalizeMessage);

export const contactRequestIdParamSchema = z
  .object({ requestId: objectIdSchema })
  .strict();

export const contactUserIdParamSchema = z
  .object({ userId: objectIdSchema })
  .strict();

export const createContactRequestSchema = z
  .object({
    receiverId: objectIdSchema,
    message: messageSchema.optional()
  })
  .strict();

export const listContactsQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_CONTACTS_MAX_LIMIT)
      .default(LIST_CONTACTS_DEFAULT_LIMIT)
  })
  .strict();

export const listContactRequestsQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_CONTACT_REQUESTS_MAX_LIMIT)
      .default(LIST_CONTACT_REQUESTS_DEFAULT_LIMIT)
  })
  .strict();

export type CreateContactRequestInput = z.infer<
  typeof createContactRequestSchema
>;
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
export type ListContactRequestsQuery = z.infer<
  typeof listContactRequestsQuerySchema
>;
