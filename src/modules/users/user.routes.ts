import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  deactivateMeHandler,
  getMeHandler,
  getPublicProfileHandler,
  searchUsersHandler,
  updateMeHandler
} from './user.controller';
import {
  deactivateAccountSchema,
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
