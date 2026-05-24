import { z } from 'zod';
import {
  ADD_MEMBERS_MAX_PER_REQUEST,
  CONVERSATION_MEMBER_ROLE,
  CONVERSATION_SETTINGS_WHO_CAN_SEND,
  DISAPPEARING_MESSAGE_DURATIONS,
  GROUP_MAX_MEMBERS,
  GROUP_TITLE_MAX_LENGTH,
  GROUP_TITLE_MIN_LENGTH,
  LIST_CONVERSATIONS_DEFAULT_LIMIT,
  LIST_CONVERSATIONS_MAX_LIMIT
} from './conversation.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Mirrors the sanitization rules in user.validation.ts: strip control,
// zero-width, BiDi-override and word-joiner code points so a crafted title
// cannot impersonate another group via homoglyphs.
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

const normalizeTitle = (s: string): string =>
  s.normalize('NFKC').replace(CONTROL_AND_INVISIBLE, '').replace(/\s+/g, ' ').trim();

const titleSchema = z
  .string()
  .min(GROUP_TITLE_MIN_LENGTH)
  .max(GROUP_TITLE_MAX_LENGTH)
  .transform(normalizeTitle)
  .refine((v) => v.length >= GROUP_TITLE_MIN_LENGTH, 'Title is required');

const avatarUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url('Invalid URL')
  .refine(
    (v) => /^https?:\/\//i.test(v),
    'Avatar URL must use http or https'
  );

const settingsSchema = z
  .object({
    whoCanSendMessages: z.enum(CONVERSATION_SETTINGS_WHO_CAN_SEND).optional()
  })
  .strict();

const memberRoleSchema = z.enum([
  CONVERSATION_MEMBER_ROLE.OWNER,
  CONVERSATION_MEMBER_ROLE.ADMIN,
  CONVERSATION_MEMBER_ROLE.MEMBER
]);

export const conversationIdParamSchema = z
  .object({ conversationId: objectIdSchema })
  .strict();

export const conversationMemberParamSchema = z
  .object({
    conversationId: objectIdSchema,
    userId: objectIdSchema
  })
  .strict();

export const createDirectConversationSchema = z
  .object({
    participantId: objectIdSchema
  })
  .strict();

// memberIds may contain duplicates and/or the caller's own id — the service
// dedups and excludes the creator before insert. Total membership including
// the creator is bounded by GROUP_MAX_MEMBERS.
export const createGroupConversationSchema = z
  .object({
    title: titleSchema,
    avatarUrl: avatarUrlSchema.optional(),
    memberIds: z
      .array(objectIdSchema)
      .min(1)
      .max(GROUP_MAX_MEMBERS - 1),
    settings: settingsSchema.optional()
  })
  .strict();

export const updateConversationSchema = z
  .object({
    title: titleSchema.optional(),
    avatarUrl: avatarUrlSchema.nullable().optional(),
    settings: settingsSchema.optional()
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No fields to update'
  });

export const addMembersSchema = z
  .object({
    userIds: z
      .array(objectIdSchema)
      .min(1)
      .max(ADD_MEMBERS_MAX_PER_REQUEST)
  })
  .strict();

export const updateMemberRoleSchema = z
  .object({
    role: memberRoleSchema
  })
  .strict();

export const updateReadPointerSchema = z
  .object({
    lastReadMessageId: objectIdSchema
  })
  .strict();

export const updateDisappearingMessagesSchema = z
  .object({
    duration: z.enum(DISAPPEARING_MESSAGE_DURATIONS)
  })
  .strict();

// `mutedUntil: null` clears the mute, `archived: false` clears archive. Both
// optional but at least one must be present.
export const updatePreferencesSchema = z
  .object({
    mutedUntil: z
      .string()
      .datetime({ message: 'mutedUntil must be an ISO datetime' })
      .nullable()
      .optional()
      .refine(
        (v) => v == null || new Date(v).getTime() > Date.now(),
        'mutedUntil must be in the future'
      ),
    archived: z.boolean().optional()
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No preferences to update'
  });

export const listConversationsQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_CONVERSATIONS_MAX_LIMIT)
      .default(LIST_CONVERSATIONS_DEFAULT_LIMIT),
    includeArchived: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .transform((v) => v === true || v === 'true')
      .default(false)
  })
  .strict();

export type CreateDirectConversationInput = z.infer<
  typeof createDirectConversationSchema
>;
export type CreateGroupConversationInput = z.infer<
  typeof createGroupConversationSchema
>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type AddMembersInput = z.infer<typeof addMembersSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type UpdateReadPointerInput = z.infer<typeof updateReadPointerSchema>;
export type UpdateDisappearingMessagesInput = z.infer<
  typeof updateDisappearingMessagesSchema
>;
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
export type ListConversationsQuery = z.infer<
  typeof listConversationsQuerySchema
>;
