import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema
} from './auth.validation';
import {
  changePasswordHandler,
  forgotPasswordHandler,
  loginHandler,
  logoutAllHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerHandler,
  resetPasswordHandler
} from './auth.controller';

// Per-route limits are deliberately tight on credential-touching endpoints.
// In production these should be backed by Redis (rate-limit-redis) so limits
// hold across multiple server instances; that wiring lands with the realtime
// scaling work in later modules.
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

export const authRouter: Router = Router();

authRouter.post(
  '/register',
  limiter(10, 60 * 60 * 1000),
  validate(registerSchema),
  asyncHandler(registerHandler)
);

authRouter.post(
  '/login',
  limiter(20, 15 * 60 * 1000),
  validate(loginSchema),
  asyncHandler(loginHandler)
);

authRouter.post(
  '/refresh',
  limiter(60, 15 * 60 * 1000),
  validate(refreshSchema),
  asyncHandler(refreshHandler)
);

authRouter.post(
  '/logout',
  validate(logoutSchema),
  asyncHandler(logoutHandler)
);

authRouter.post(
  '/logout-all',
  requireAuth,
  asyncHandler(logoutAllHandler)
);

authRouter.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(changePasswordHandler)
);

authRouter.post(
  '/forgot-password',
  limiter(5, 60 * 60 * 1000),
  validate(forgotPasswordSchema),
  asyncHandler(forgotPasswordHandler)
);

authRouter.post(
  '/reset-password',
  limiter(10, 60 * 60 * 1000),
  validate(resetPasswordSchema),
  asyncHandler(resetPasswordHandler)
);

authRouter.get('/me', requireAuth, asyncHandler(meHandler));
