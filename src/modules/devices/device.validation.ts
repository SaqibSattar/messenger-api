import { z } from 'zod';
import {
  DEVICE_APP_VERSION_MAX_LENGTH,
  DEVICE_DEVICE_NAME_MAX_LENGTH,
  DEVICE_LOCALE_MAX_LENGTH,
  DEVICE_PLATFORMS,
  DEVICE_PUSH_PROVIDERS,
  DEVICE_PUSH_TOKEN_MAX_LENGTH,
  LIST_DEVICES_DEFAULT_LIMIT,
  LIST_DEVICES_MAX_LIMIT
} from './device.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// z.enum needs a non-empty tuple literal. Spread to preserve the union type
// without TS narrowing the readonly arrays to `string[]`.
const platformValues = [...DEVICE_PLATFORMS] as [
  (typeof DEVICE_PLATFORMS)[number],
  ...(typeof DEVICE_PLATFORMS)[number][]
];
const providerValues = [...DEVICE_PUSH_PROVIDERS] as [
  (typeof DEVICE_PUSH_PROVIDERS)[number],
  ...(typeof DEVICE_PUSH_PROVIDERS)[number][]
];

// Strip control / zero-width chars from human-facing display fields so a
// hostile client cannot stuff a "your devices" list with an invisible payload.
// Mirrors the same sanitizer used on user bios and contact messages.
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

const deviceNameSchema = z
  .string()
  .max(DEVICE_DEVICE_NAME_MAX_LENGTH)
  .transform(normalizeText);

const appVersionSchema = z
  .string()
  .max(DEVICE_APP_VERSION_MAX_LENGTH)
  .transform((s) => s.trim());

const localeSchema = z
  .string()
  .max(DEVICE_LOCALE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid locale')
  .transform((s) => s.trim());

const pushTokenSchema = z
  .string()
  .min(1)
  .max(DEVICE_PUSH_TOKEN_MAX_LENGTH)
  .transform((s) => s.trim());

export const deviceIdParamSchema = z
  .object({ deviceId: objectIdSchema })
  .strict();

export const registerDeviceSchema = z
  .object({
    platform: z.enum(platformValues),
    pushProvider: z.enum(providerValues),
    pushToken: pushTokenSchema,
    deviceName: deviceNameSchema.optional(),
    appVersion: appVersionSchema.optional(),
    locale: localeSchema.optional()
  })
  .strict();

// Only metadata is patchable — the pushToken/platform/provider tuple defines
// what a device IS, so changing them would effectively re-register a different
// device. A client that wants a new token must POST a new device.
export const updateDeviceSchema = z
  .object({
    deviceName: deviceNameSchema.optional(),
    appVersion: appVersionSchema.optional(),
    locale: localeSchema.optional()
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No fields to update'
  });

export const listDevicesQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_DEVICES_MAX_LIMIT)
      .default(LIST_DEVICES_DEFAULT_LIMIT),
    // Default hides revoked rows — a client asking "my devices" almost
    // always means "my active devices". Operators can opt-in for audit.
    includeRevoked: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .transform((v) => v === true || v === 'true')
      .default(false)
  })
  .strict();

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>;
