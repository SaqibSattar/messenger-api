import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  createInviteHandler,
  joinByInviteHandler,
  listInvitesHandler,
  revokeInviteHandler
} from './invite.controller';
import {
  conversationIdParamSchema,
  createInviteSchema,
  inviteIdParamSchema,
  inviteTokenParamSchema
} from './invite.validation';

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

// Mounted under /api/v1/conversations/:conversationId/invites so the
// conversationId comes from the parent route.
export const conversationInvitesRouter: Router = Router({ mergeParams: true });

conversationInvitesRouter.use(requireAuth);

conversationInvitesRouter.post(
  '/',
  // Creation is sensitive but admin-gated; per-admin cap of 60/hour is
  // generous enough for normal ops while still bounding misuse.
  limiter(60, 60 * 60 * 1000),
  validate(conversationIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.INVITE_CREATE),
  validate(createInviteSchema),
  asyncHandler(createInviteHandler)
);

conversationInvitesRouter.get(
  '/',
  validate(conversationIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.INVITE_CREATE),
  asyncHandler(listInvitesHandler)
);

// Top-level invite router. Holds the join + delete-by-id endpoints which
// don't carry the conversationId in the URL.
export const inviteRouter: Router = Router();

inviteRouter.use(requireAuth);

inviteRouter.post(
  '/:token/join',
  // Tight cap on join attempts per IP. Defends against a brute-force search
  // for valid tokens. Token length already makes a successful guess
  // negligible, but rate limiting saves CPU on hash computation.
  limiter(30, 5 * 60 * 1000),
  validate(inviteTokenParamSchema, 'params'),
  requirePermission(PERMISSIONS.INVITE_REDEEM),
  asyncHandler(joinByInviteHandler),
);

inviteRouter.delete(
  '/:inviteId',
  validate(inviteIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.INVITE_CREATE),
  asyncHandler(revokeInviteHandler)
);
