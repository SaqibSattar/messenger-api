import { z } from 'zod';
import {
  LIST_MESSAGES_DEFAULT_LIMIT,
  LIST_MESSAGES_MAX_LIMIT,
  MESSAGE_TEXT_MAX_LENGTH,
  REACTION_EMOJI_MAX_LENGTH
} from './message.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Mirrors the user/conversation sanitizers: strip C0/C1 controls, zero-width
// runes, BiDi-override marks, and word-joiner/BOM points so a crafted body
// can't smuggle invisible payload past front-end renderers. LF is preserved
// because multi-line message bodies are legitimate.
const CONTROL_AND_INVISIBLE_KEEP_LF = new RegExp(
  '[' +
    '\\u0000-\\u0009' +
    '\\u000B-\\u001F' +
    '\\u007F-\\u009F' +
    '\\u200B-\\u200F' +
    '\\u2028-\\u2029' +
    '\\u202A-\\u202E' +
    '\\u2060-\\u2064' +
    '\\uFEFF' +
    ']',
  'g'
);

const normalizeMessageText = (s: string): string =>
  s
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_AND_INVISIBLE_KEEP_LF, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const messageTextSchema = z
  .string()
  .max(MESSAGE_TEXT_MAX_LENGTH)
  .transform(normalizeMessageText);

// Reaction normalization is narrower: NFC (preserves emoji ZWJ sequences)
// rather than NFKC, and only invisibles that have nothing to do with the
// emoji rendering itself are stripped. Pure ZWJ inside an emoji is a valid
// composition glue and must survive.
const REACTION_INVISIBLE = new RegExp(
  '[' +
    '\\u0000-\\u001F' +
    '\\u007F-\\u009F' +
    '\\u2028-\\u2029' +
    '\\u202A-\\u202E' +
    '\\u2060-\\u2064' +
    '\\uFEFF' +
    ']',
  'g'
);

const normalizeReactionEmoji = (s: string): string =>
  s.normalize('NFC').replace(REACTION_INVISIBLE, '').trim();

const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(REACTION_EMOJI_MAX_LENGTH)
  .transform(normalizeReactionEmoji)
  .refine((v) => v.length >= 1, 'Emoji is required')
  // Reject anything that looks like ASCII text masquerading as a reaction —
  // this isn't an exhaustive emoji check, just a cheap guard against abuse
  // ("hahaha" as a "reaction").
  .refine(
    (v) => !/^[\x20-\x7E]+$/.test(v),
    'Reaction must be an emoji'
  );

export const conversationIdParamSchema = z
  .object({ conversationId: objectIdSchema })
  .strict();

export const messageIdParamSchema = z
  .object({ messageId: objectIdSchema })
  .strict();

export const messageReactionParamSchema = z
  .object({
    messageId: objectIdSchema,
    reactionId: objectIdSchema
  })
  .strict();

export const sendMessageSchema = z
  .object({
    text: messageTextSchema.optional(),
    replyToMessageId: objectIdSchema.optional()
  })
  .strict()
  .refine((d) => (d.text?.length ?? 0) > 0, {
    message: 'Message must have non-empty text'
  });

export const editMessageSchema = z
  .object({
    text: messageTextSchema
  })
  .strict()
  .refine((d) => d.text.length > 0, {
    message: 'Message text cannot be empty'
  });

export const listMessagesQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_MESSAGES_MAX_LIMIT)
      .default(LIST_MESSAGES_DEFAULT_LIMIT)
  })
  .strict();

export const addReactionSchema = z
  .object({
    emoji: reactionEmojiSchema
  })
  .strict();

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
export type AddReactionInput = z.infer<typeof addReactionSchema>;
