import { z } from 'zod';
import {
  INVITE_MAX_TTL_SECONDS,
  INVITE_MAX_USES_LIMIT,
  INVITE_MIN_USES_LIMIT,
  INVITE_TOKEN_MAX_LENGTH,
  INVITE_TOKEN_MIN_LENGTH
} from './invite.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Tokens are base64url (RFC 4648 §5: A-Z a-z 0-9 - _) without padding.
// Anchored both ends to reject any other characters.
const inviteTokenSchema = z
  .string()
  .trim()
  .min(INVITE_TOKEN_MIN_LENGTH)
  .max(INVITE_TOKEN_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid invite token');

export const conversationIdParamSchema = z
  .object({ conversationId: objectIdSchema })
  .strict();

export const inviteIdParamSchema = z
  .object({ inviteId: objectIdSchema })
  .strict();

export const inviteTokenParamSchema = z
  .object({ token: inviteTokenSchema })
  .strict();

export const createInviteSchema = z
  .object({
    // expiresInSeconds: caller-controlled TTL. When omitted we use the
    // module default. Capped on the upper end so a single admin cannot stash
    // a never-expiring link.
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .max(INVITE_MAX_TTL_SECONDS)
      .optional(),
    maxUses: z
      .number()
      .int()
      .min(INVITE_MIN_USES_LIMIT)
      .max(INVITE_MAX_USES_LIMIT)
      .optional()
  })
  .strict();

export type CreateInviteInput = z.infer<typeof createInviteSchema>;
