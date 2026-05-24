import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  searchConversationsHandler,
  searchMessagesHandler,
  searchUsersHandler
} from './search.controller';
import {
  searchConversationsQuerySchema,
  searchMessagesQuerySchema,
  searchUsersQuerySchema
} from './search.validation';

// Search is an abuse-prone surface — regex queries are O(n) on the indexed
// fields without a text index, and bursty users can starve the DB. Cap
// strictly per-IP (per-user once Redis-backed limits land).
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

export const searchRouter: Router = Router();

searchRouter.use(requireAuth);

// All search endpoints share the same per-route limiter. 60/min is generous
// for normal usage but still bounds a runaway client. The conversation read
// permission gates these — anonymous search is not supported.
searchRouter.get(
  '/conversations',
  limiter(60, 60 * 1000),
  requirePermission(PERMISSIONS.CONVERSATION_READ),
  validate(searchConversationsQuerySchema, 'query'),
  asyncHandler(searchConversationsHandler)
);

searchRouter.get(
  '/messages',
  limiter(60, 60 * 1000),
  requirePermission(PERMISSIONS.CONVERSATION_READ),
  validate(searchMessagesQuerySchema, 'query'),
  asyncHandler(searchMessagesHandler)
);

searchRouter.get(
  '/users',
  limiter(60, 60 * 1000),
  validate(searchUsersQuerySchema, 'query'),
  asyncHandler(searchUsersHandler)
);
