import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  getSystemSummaryHandler,
  listAuditLogsHandler,
  updateUserRoleHandler,
  updateUserCustomPermissionsHandler
} from './admin.controller';
import {
  listAuditLogsQuerySchema,
  updateCustomPermissionsSchema,
  updateRoleSchema,
  userIdParamSchema
} from './admin.validation';

export const adminRouter: Router = Router();

adminRouter.use(requireAuth);

adminRouter.patch(
  '/users/:userId/role',
  validate(userIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.ADMIN_USERS_MANAGE),
  validate(updateRoleSchema),
  asyncHandler(updateUserRoleHandler)
);

adminRouter.patch(
  '/users/:userId/permissions',
  validate(userIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.ADMIN_USERS_MANAGE),
  validate(updateCustomPermissionsSchema),
  asyncHandler(updateUserCustomPermissionsHandler)
);

// Audit log queue is admin-only. We gate at the route AND in the service so
// any future direct service caller (jobs, CLI tooling) still pays the check.
adminRouter.get(
  '/audit-logs',
  requirePermission(PERMISSIONS.ADMIN_AUDIT_READ),
  validate(listAuditLogsQuerySchema, 'query'),
  asyncHandler(listAuditLogsHandler)
);

adminRouter.get(
  '/system-summary',
  requirePermission(PERMISSIONS.ADMIN_SYSTEM_READ),
  asyncHandler(getSystemSummaryHandler)
);
