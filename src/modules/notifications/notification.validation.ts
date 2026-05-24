import { z } from 'zod';
import {
  LIST_NOTIFICATIONS_DEFAULT_LIMIT,
  LIST_NOTIFICATIONS_MAX_LIMIT,
  NOTIFICATION_TYPE
} from './notification.types';

// Zod's z.enum requires a tuple — spread the constant object so the literal
// type is preserved without TS narrowing it to readonly string[].
const NOTIFICATION_TYPE_VALUES = Object.values(NOTIFICATION_TYPE) as [
  (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE],
  ...(typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE][]
];

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

export const notificationIdParamSchema = z
  .object({ notificationId: objectIdSchema })
  .strict();

// `unreadOnly=true` filters to unread inbox rows. Defaults to false so a
// caller without query params gets the full timeline.
export const listNotificationsQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_NOTIFICATIONS_MAX_LIMIT)
      .default(LIST_NOTIFICATIONS_DEFAULT_LIMIT),
    unreadOnly: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .transform((v) => v === true || v === 'true')
      .default(false),
    type: z.enum(NOTIFICATION_TYPE_VALUES).optional()
  })
  .strict();

// `mutedConversationIds` is set wholesale rather than diffed — the client
// owns the authoritative list and a single round-trip prevents lost-update
// races between concurrent toggles. The size cap stops a malicious client
// from stuffing the document with thousands of ids.
export const updateNotificationPreferencesSchema = z
  .object({
    pushEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
    messagePreviewEnabled: z.boolean().optional(),
    mutedConversationIds: z.array(objectIdSchema).max(500).optional()
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No preferences to update'
  });

export type ListNotificationsQuery = z.infer<
  typeof listNotificationsQuerySchema
>;
export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;
