import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  cancelDeleteMeHandler,
  dataExportMeHandler,
  deactivateMeHandler,
  getMeHandler,
  getPublicProfileHandler,
  requestDeleteMeHandler,
  searchUsersHandler,
  updateMeHandler
} from './user.controller';
import {
  cancelDeletionSchema,
  deactivateAccountSchema,
  requestDeletionSchema,
  searchUsersSchema,
  updateProfileSchema,
  userIdParamSchema
} from './user.validation';

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

export const userRouter: Router = Router();

// All user routes require authentication. /search and /public are intentionally
// not anonymous — exposing them to unauthenticated callers would invite scraping
// and enumeration even with exact-match-only semantics.
userRouter.use(requireAuth);

userRouter.get('/me', asyncHandler(getMeHandler));

userRouter.patch(
  '/me',
  validate(updateProfileSchema),
  asyncHandler(updateMeHandler)
);

userRouter.post(
  '/me/deactivate',
  limiter(5, 60 * 60 * 1000),
  validate(deactivateAccountSchema),
  asyncHandler(deactivateMeHandler)
);

// Account-deletion lifecycle (prompt 16). All three sit under /users/me so the
// client only needs one base. Heavy rate-limits — these are catastrophic
// actions, NOT operations a legitimate client repeats.
userRouter.post(
  '/me/delete-request',
  limiter(5, 60 * 60 * 1000),
  validate(requestDeletionSchema),
  asyncHandler(requestDeleteMeHandler)
);

userRouter.post(
  '/me/delete-cancel',
  limiter(10, 60 * 60 * 1000),
  validate(cancelDeletionSchema),
  asyncHandler(cancelDeleteMeHandler)
);

// Data export. Limited tightly per hour — generating an export touches every
// collection for the caller and is the expensive read on this route surface.
userRouter.get(
  '/me/data-export',
  limiter(3, 60 * 60 * 1000),
  asyncHandler(dataExportMeHandler)
);

userRouter.get(
  '/search',
  limiter(30, 60 * 1000),
  validate(searchUsersSchema, 'query'),
  asyncHandler(searchUsersHandler)
);

userRouter.get(
  '/:userId/public',
  validate(userIdParamSchema, 'params'),
  asyncHandler(getPublicProfileHandler)
);
