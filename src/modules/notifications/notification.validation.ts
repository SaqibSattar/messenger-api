import { z } from 'zod';
import {
  LIST_NOTIFICATIONS_DEFAULT_LIMIT,
  LIST_NOTIFICATIONS_MAX_LIMIT,
  NOTIFICATION_TYPE,
  QUIET_HOURS_MINUTES_PER_DAY,
  QUIET_HOURS_TIMEZONE_MAX_LENGTH
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

// IANA timezone names. We don't ship the full IANA database for validation —
// the regex covers the canonical shape (Area/Location, with optional sub
// regions) and the length cap stops a hostile client from inflating the
// document. A truly bogus zone surfaces as a no-op at fan-out time (we treat
// "unknown zone" as "quiet hours not configured") which is the safe failure.
const timezoneSchema = z
  .string()
  .max(QUIET_HOURS_TIMEZONE_MAX_LENGTH)
  .regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/, 'Invalid timezone');

const quietHoursSchema = z
  .object({
    startMinute: z
      .number()
      .int()
      .min(0)
      .max(QUIET_HOURS_MINUTES_PER_DAY - 1),
    endMinute: z
      .number()
      .int()
      .min(0)
      .max(QUIET_HOURS_MINUTES_PER_DAY - 1),
    timezone: timezoneSchema
  })
  .strict()
  .refine((v) => v.startMinute !== v.endMinute, {
    message: 'startMinute and endMinute must differ'
  });

// `mutedConversationIds` is set wholesale rather than diffed — the client
// owns the authoritative list and a single round-trip prevents lost-update
// races between concurrent toggles. The size cap stops a malicious client
// from stuffing the document with thousands of ids.
//
// `quietHours: null` clears the window; an object replaces it.
export const updateNotificationPreferencesSchema = z
  .object({
    pushEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
    messagePreviewEnabled: z.boolean().optional(),
    soundEnabled: z.boolean().optional(),
    vibrationEnabled: z.boolean().optional(),
    quietHours: quietHoursSchema.nullable().optional(),
    mutedConversationIds: z.array(objectIdSchema).max(500).optional()
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No preferences to update'
  });

// Per-conversation preference patch. `mutedUntil: null` clears the mute.
export const conversationNotificationPreferenceParamSchema = z
  .object({ conversationId: objectIdSchema })
  .strict();

export const updateConversationNotificationPreferenceSchema = z
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
    mentionOnly: z.boolean().optional()
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
export type UpdateConversationNotificationPreferenceInput = z.infer<
  typeof updateConversationNotificationPreferenceSchema
>;
