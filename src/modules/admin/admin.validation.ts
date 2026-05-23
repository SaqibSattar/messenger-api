import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  ROLES,
  type Permission
} from '../permissions/permissions.constants';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

export const userIdParamSchema = z
  .object({ userId: objectIdSchema })
  .strict();

export const updateRoleSchema = z
  .object({
    role: z.enum([
      ROLES.MEMBER,
      ROLES.MODERATOR,
      ROLES.ADMIN,
      ROLES.SUPER_ADMIN
    ]),
    reason: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export const updateCustomPermissionsSchema = z
  .object({
    customPermissions: z
      .array(z.enum([...ALL_PERMISSIONS] as [Permission, ...Permission[]]))
      .max(64),
    reason: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type UpdateCustomPermissionsInput = z.infer<
  typeof updateCustomPermissionsSchema
>;
