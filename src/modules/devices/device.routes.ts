import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  listDevicesHandler,
  registerDeviceHandler,
  unregisterDeviceHandler,
  updateDeviceHandler
} from './device.controller';
import {
  deviceIdParamSchema,
  listDevicesQuerySchema,
  registerDeviceSchema,
  updateDeviceSchema
} from './device.validation';

const limiter = (limit: number, windowMs: number) => {
  const opts: Partial<Options> = {
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest
  };
  return rateLimit(opts as Options);
};

export const deviceRouter: Router = Router();

deviceRouter.use(requireAuth);

// Device registration is a write surface a hostile client could spam to
// pollute the unique-token index. Tight limiter; legitimate clients register
// at most a handful of times per day (token refresh, app reinstall).
deviceRouter.post(
  '/',
  limiter(30, 60 * 60 * 1000),
  requirePermission(PERMISSIONS.DEVICE_MANAGE_OWN),
  validate(registerDeviceSchema),
  asyncHandler(registerDeviceHandler)
);

deviceRouter.get(
  '/',
  requirePermission(PERMISSIONS.DEVICE_MANAGE_OWN),
  validate(listDevicesQuerySchema, 'query'),
  asyncHandler(listDevicesHandler)
);

deviceRouter.patch(
  '/:deviceId',
  limiter(60, 60 * 60 * 1000),
  requirePermission(PERMISSIONS.DEVICE_MANAGE_OWN),
  validate(deviceIdParamSchema, 'params'),
  validate(updateDeviceSchema),
  asyncHandler(updateDeviceHandler)
);

deviceRouter.delete(
  '/:deviceId',
  requirePermission(PERMISSIONS.DEVICE_MANAGE_OWN),
  validate(deviceIdParamSchema, 'params'),
  asyncHandler(unregisterDeviceHandler)
);
