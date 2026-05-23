import { z } from 'zod';
import { env } from '../../config/env';

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address')
  .max(254);

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{6,14}$/, 'Invalid phone number');

const passwordSchema = z
  .string()
  .min(env.PASSWORD_MIN_LENGTH, `Password must be at least ${env.PASSWORD_MIN_LENGTH} characters`)
  .max(env.PASSWORD_MAX_LENGTH);

const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name is required')
  .max(80);

// Tokens are opaque to the API; we just need a non-empty bounded string here.
// The actual JWT verification happens in the service.
const tokenSchema = z.string().trim().min(20).max(4096);

export const registerSchema = z
  .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    password: passwordSchema,
    displayName: displayNameSchema
  })
  .strict()
  .refine((data) => Boolean(data.email ?? data.phone), {
    message: 'Either email or phone is required',
    path: ['email']
  });

export const loginSchema = z
  .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    password: z.string().min(1).max(env.PASSWORD_MAX_LENGTH)
  })
  .strict()
  .refine((data) => Boolean(data.email ?? data.phone), {
    message: 'Either email or phone is required',
    path: ['email']
  });

export const refreshSchema = z
  .object({ refreshToken: tokenSchema })
  .strict();

export const logoutSchema = z
  .object({ refreshToken: tokenSchema })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(env.PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema
  })
  .strict()
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must be different from current password',
    path: ['newPassword']
  });

export const forgotPasswordSchema = z
  .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional()
  })
  .strict()
  .refine((data) => Boolean(data.email ?? data.phone), {
    message: 'Either email or phone is required',
    path: ['email']
  });

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(10).max(512),
    newPassword: passwordSchema
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
