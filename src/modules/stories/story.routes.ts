import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  createStoryHandler,
  createStoryMuteHandler,
  deleteStoryHandler,
  deleteStoryMuteHandler,
  getStoryHandler,
  listStoriesHandler,
  listStoryViewersHandler,
  markStoryViewedHandler,
  reportStoryHandler
} from './story.controller';
import {
  createStoryMuteSchema,
  createStorySchema,
  listStoriesQuerySchema,
  listStoryViewersQuerySchema,
  reportStorySchema,
  storyIdParamSchema,
  storyMuteParamSchema
} from './story.validation';

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

export const storyRouter: Router = Router();

storyRouter.use(requireAuth);

// Creates are expensive (fan-out resolution + media validation). The hourly
// cap is loose enough for normal authoring but tight enough that a script
// can't spam audience-resolution scans.
storyRouter.post(
  '/',
  limiter(60, 60 * 60 * 1000),
  requirePermission(PERMISSIONS.STORY_CREATE),
  validate(createStorySchema),
  asyncHandler(createStoryHandler)
);

storyRouter.get(
  '/',
  requirePermission(PERMISSIONS.STORY_READ),
  validate(listStoriesQuerySchema, 'query'),
  asyncHandler(listStoriesHandler)
);

// Mutes routes are defined BEFORE /:storyId so the literal `mutes` path
// segment is matched correctly — without this, Express would treat 'mutes'
// as a storyId and the validator would reject it as a malformed ObjectId.
storyRouter.post(
  '/mutes',
  limiter(60, 60 * 1000),
  validate(createStoryMuteSchema),
  asyncHandler(createStoryMuteHandler)
);

storyRouter.delete(
  '/mutes/:userId',
  validate(storyMuteParamSchema, 'params'),
  asyncHandler(deleteStoryMuteHandler)
);

storyRouter.get(
  '/:storyId',
  validate(storyIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.STORY_READ),
  asyncHandler(getStoryHandler)
);

storyRouter.post(
  '/:storyId/view',
  // Each view-mark writes a doc and emits a story.viewed event. Cap is
  // generous since clients legitimately ping this when scrolling stories.
  limiter(180, 60 * 1000),
  validate(storyIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.STORY_READ),
  asyncHandler(markStoryViewedHandler)
);

storyRouter.get(
  '/:storyId/viewers',
  validate(storyIdParamSchema, 'params'),
  validate(listStoryViewersQuerySchema, 'query'),
  asyncHandler(listStoryViewersHandler)
);

storyRouter.delete(
  '/:storyId',
  validate(storyIdParamSchema, 'params'),
  asyncHandler(deleteStoryHandler)
);

storyRouter.post(
  '/:storyId/report',
  // Tight cap on reporting — abuse here translates into noise for the
  // moderation queue.
  limiter(20, 60 * 60 * 1000),
  requirePermission(PERMISSIONS.REPORT_CREATE),
  validate(storyIdParamSchema, 'params'),
  validate(reportStorySchema),
  asyncHandler(reportStoryHandler)
);
