import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  updateUserRoleHandler,
  updateUserCustomPermissionsHandler
} from './admin.controller';
import {
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
