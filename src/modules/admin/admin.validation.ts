import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  ROLES,
  type Permission
} from '../permissions/permissions.constants';
import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AUDIT_TARGET_TYPES,
  type AuditTargetType
} from './auditLog.types';

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

// Cap the `action` filter at 100 chars to match the model and the regex stops
// path-like (`a.b`) or operator-like (`$x`) inputs from leaking through.
const auditActionSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    'action may only contain letters, numbers, _, ., -'
  );

const isoDateSchema = z.string().datetime({ offset: true });

export const listAuditLogsQuerySchema = z
  .object({
    cursor: objectIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AUDIT_LIST_MAX_LIMIT)
      .default(AUDIT_LIST_DEFAULT_LIMIT),
    actorId: objectIdSchema.optional(),
    action: auditActionSchema.optional(),
    targetType: z
      .enum(
        AUDIT_TARGET_TYPES as readonly [AuditTargetType, ...AuditTargetType[]]
      )
      .optional(),
    targetId: z.string().trim().min(1).max(64).optional(),
    since: isoDateSchema.optional(),
    until: isoDateSchema.optional()
  })
  .strict()
  .refine(
    (data) => !(data.targetId && !data.targetType),
    'targetType is required when targetId is provided'
  );

export type ListAuditLogsQueryInput = z.infer<typeof listAuditLogsQuerySchema>;
