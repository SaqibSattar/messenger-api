import { z } from 'zod';
import { env } from '../../config/env';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  BLOCKED_EXTENSIONS,
  FILENAME_MAX_LENGTH
} from './media.types';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

// Filename sanitizer.
//
// Goal: keep something close enough to the original for the UI to show, but
// strip everything that could become a path traversal, a control sequence,
// or an injection target downstream. The result is never used as a storage
// key — that comes from the provider — but it ends up in DTOs and audit logs.
const FILENAME_INVALID = new RegExp(
  '[' +
    '\\u0000-\\u001F' +
    '\\u007F-\\u009F' +
    '\\u200B-\\u200F' +
    '\\u2028-\\u2029' +
    '\\u202A-\\u202E' +
    '\\u2060-\\u2064' +
    '\\uFEFF' +
    '/' +
    '\\\\' +
    ']',
  'g'
);

const sanitizeFilename = (s: string): string => {
  const collapsed = s
    .normalize('NFKC')
    .replace(FILENAME_INVALID, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Strip leading dots so a name like `..config` cannot become a hidden
  // dotfile when written somewhere unexpected. Single trailing dots on
  // Windows also alias filenames; drop them too.
  return collapsed.replace(/^\.+/, '').replace(/\.+$/, '');
};

const extractExtension = (filename: string): string => {
  const idx = filename.lastIndexOf('.');
  if (idx < 0 || idx === filename.length - 1) return '';
  return filename.slice(idx + 1).toLowerCase();
};

const filenameSchema = z
  .string()
  .min(1)
  .max(FILENAME_MAX_LENGTH)
  .transform(sanitizeFilename)
  .refine((v) => v.length > 0, 'Filename is required')
  .refine((v) => v.length <= FILENAME_MAX_LENGTH, 'Filename is too long');

const mimeTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (v): v is (typeof ALLOWED_MIME_TYPES)[number] =>
      (ALLOWED_MIME_TYPES as readonly string[]).includes(v),
    'Unsupported MIME type'
  );

export const attachmentIdParamSchema = z
  .object({ attachmentId: objectIdSchema })
  .strict();

export const createUploadUrlSchema = z
  .object({
    filename: filenameSchema,
    mimeType: mimeTypeSchema,
    sizeBytes: z.number().int().positive().max(env.MEDIA_MAX_BYTES),
    // Optional checksum the client computed locally. Stored for audit; the
    // service does not currently verify it against actual bytes (the storage
    // provider would do that in production via integrity headers).
    checksumSha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-f0-9]{64}$/, 'checksumSha256 must be 64 hex chars')
      .optional(),
    // Optional dimensions/duration the client knows up-front. We store as
    // metadata only — never use as a security signal.
    width: z.number().int().positive().max(100_000).optional(),
    height: z.number().int().positive().max(100_000).optional(),
    durationSeconds: z.number().int().positive().max(24 * 60 * 60).optional()
  })
  .strict()
  // Extension must be on the allowlist and not on the blocklist. The MIME
  // type check has already happened above; both layers together close the
  // "fake the MIME, weaponize the extension" gap.
  .superRefine((data, ctx) => {
    const ext = extractExtension(data.filename);
    if (!ext) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filename'],
        message: 'Filename must have an extension'
      });
      return;
    }
    if (BLOCKED_EXTENSIONS.has(ext)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filename'],
        message: 'This file type is not allowed'
      });
      return;
    }
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filename'],
        message: 'Unsupported file extension'
      });
    }
  });

export const completeUploadSchema = z
  .object({
    attachmentId: objectIdSchema,
    // Final reported size after the upload finishes. The service — not the
    // schema — enforces the byte cap so an over-size report can transition
    // the attachment to `rejected` and trigger cleanup. A schema-level reject
    // here would lose that signal.
    sizeBytes: z.number().int().positive().optional(),
    checksumSha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-f0-9]{64}$/, 'checksumSha256 must be 64 hex chars')
      .optional(),
    width: z.number().int().positive().max(100_000).optional(),
    height: z.number().int().positive().max(100_000).optional(),
    durationSeconds: z.number().int().positive().max(24 * 60 * 60).optional()
  })
  .strict();

export type CreateUploadUrlInput = z.infer<typeof createUploadUrlSchema>;
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;

// Helpers exported so the service can re-use the same sanitizer/extractor.
export const __filenameInternals = { sanitizeFilename, extractExtension };
