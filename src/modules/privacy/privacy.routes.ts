import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  getPrivacySettingsHandler,
  updatePrivacySettingsHandler
} from './privacy.controller';
import { updatePrivacySettingsSchema } from './privacy.validation';

export const privacyRouter: Router = Router();

privacyRouter.use(requireAuth);

privacyRouter.get(
  '/',
  requirePermission(PERMISSIONS.PRIVACY_MANAGE_OWN),
  asyncHandler(getPrivacySettingsHandler)
);

privacyRouter.patch(
  '/',
  requirePermission(PERMISSIONS.PRIVACY_MANAGE_OWN),
  validate(updatePrivacySettingsSchema),
  asyncHandler(updatePrivacySettingsHandler)
);
