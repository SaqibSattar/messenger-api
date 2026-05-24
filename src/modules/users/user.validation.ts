import { z } from 'zod';
import { env } from '../../config/env';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Strip categories that enable homoglyph / display-spoofing attacks:
//   C0 controls               U+0000-U+001F
//   DEL + C1 controls         U+007F-U+009F
//   zero-width + BiDi marks   U+200B-U+200F
//   line/paragraph separators U+2028-U+2029
//   BiDi override controls    U+202A-U+202E
//   word joiner / invisibles  U+2060-U+2064
//   BOM                       U+FEFF
// Built from \u escapes (ASCII source) to keep this readable in any editor.
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

// Same set as CONTROL_AND_INVISIBLE but allows LF (U+000A). Used for bios,
// which may legitimately contain newlines.
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

const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();
const stripInvisible = (s: string): string =>
  s.normalize('NFKC').replace(CONTROL_AND_INVISIBLE, '');
const normalizeText = (s: string): string =>
  collapseWhitespace(stripInvisible(s));

const displayNameSchema = z
  .string()
  .min(1)
  .max(80)
  .transform(normalizeText)
  .refine((v) => v.length >= 1, 'Display name is required');

// Bios may contain newlines but no control/invisible spoofing chars.
// Normalize CR/CRLF -> LF, strip everything else, then trim.
const bioSchema = z
  .string()
  .max(280)
  .transform((s) =>
    s
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      .replace(CONTROL_AND_INVISIBLE_KEEP_LF, '')
      .trim()
  );

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username must be at most 30 characters')
  .regex(
    /^[a-z][a-z0-9._]*[a-z0-9]$/,
    'Username must start with a letter, end with a letter or digit, and contain only lowercase letters, digits, dots, or underscores'
  )
  .refine((v) => !v.includes('..'), 'Username cannot contain consecutive dots')
  .refine((v) => !v.includes('__'), 'Username cannot contain consecutive underscores');

const avatarUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url('Invalid URL')
  .refine(
    (v) => /^https?:\/\//i.test(v),
    'Avatar URL must use http or https'
  );

const privacySettingsSchema = z
  .object({
    discoverableByEmail: z.boolean().optional(),
    discoverableByPhone: z.boolean().optional(),
    discoverableByUsername: z.boolean().optional(),
    showLastSeen: z.boolean().optional(),
    showOnlineStatus: z.boolean().optional()
  })
  .strict();

// strict() rejects unknown keys (role, status, email, customPermissions,
// passwordHash, etc.). Combined with the route-level Zod validate middleware
// this is our mass-assignment guard.
export const updateProfileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    username: usernameSchema.optional(),
    bio: bioSchema.optional(),
    avatarUrl: avatarUrlSchema.nullable().optional(),
    privacySettings: privacySettingsSchema.optional()
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No fields to update'
  });

export const userIdParamSchema = z
  .object({ userId: objectIdSchema })
  .strict();

const emailQuerySchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email')
  .max(254);

const phoneQuerySchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{6,14}$/, 'Invalid phone number');

const usernameQuerySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(30);

// Exactly one of email|phone|username must be present. Partial / substring
// search is intentionally not supported — that is the path to enumeration.
export const searchUsersSchema = z
  .object({
    email: emailQuerySchema.optional(),
    phone: phoneQuerySchema.optional(),
    username: usernameQuerySchema.optional()
  })
  .strict()
  .refine(
    (data) => {
      const provided = [data.email, data.phone, data.username].filter(
        (v) => v !== undefined
      );
      return provided.length === 1;
    },
    {
      message: 'Provide exactly one of email, phone, or username'
    }
  );

export const deactivateAccountSchema = z
  .object({
    password: z.string().min(1).max(env.PASSWORD_MAX_LENGTH),
    reason: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type SearchUsersInput = z.infer<typeof searchUsersSchema>;
export type DeactivateAccountInput = z.infer<typeof deactivateAccountSchema>;
