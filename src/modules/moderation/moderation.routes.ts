import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  createBlockHandler,
  listBlocksHandler,
  removeBlockHandler
} from './block.controller';
import {
  blockedUserIdParamSchema,
  createBlockSchema,
  listBlocksQuerySchema
} from './block.validation';
import {
  createReportHandler,
  getReportHandler,
  listReportsHandler,
  updateReportStatusHandler
} from './report.controller';
import {
  createReportSchema,
  listReportsQuerySchema,
  reportIdParamSchema,
  updateReportStatusSchema
} from './report.validation';
import {
  createModerationActionHandler,
  listModerationActionsHandler
} from './moderation.controller';
import {
  createModerationActionSchema,
  listModerationActionsQuerySchema
} from './moderation.validation';

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

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export const blockRouter: Router = Router();

blockRouter.use(requireAuth);

blockRouter.post(
  '/',
  limiter(60, 60 * 60 * 1000),
  validate(createBlockSchema),
  asyncHandler(createBlockHandler)
);

blockRouter.get(
  '/',
  validate(listBlocksQuerySchema, 'query'),
  asyncHandler(listBlocksHandler)
);

blockRouter.delete(
  '/:blockedUserId',
  validate(blockedUserIdParamSchema, 'params'),
  asyncHandler(removeBlockHandler)
);

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const reportRouter: Router = Router();

reportRouter.use(requireAuth);

// Reporting is a high-abuse surface — anonymous-style spam can flood a queue.
// Cap creation strictly; reviewers reading the queue are bounded by their
// permission, not by a rate.
reportRouter.post(
  '/',
  limiter(20, 60 * 60 * 1000),
  requirePermission(PERMISSIONS.REPORT_CREATE),
  validate(createReportSchema),
  asyncHandler(createReportHandler)
);

reportRouter.get(
  '/',
  validate(listReportsQuerySchema, 'query'),
  asyncHandler(listReportsHandler)
);

reportRouter.get(
  '/:reportId',
  validate(reportIdParamSchema, 'params'),
  asyncHandler(getReportHandler)
);

// Permission gate at route level for fast rejection. The service still
// performs the resource-level checks (e.g. cannot review your own report).
reportRouter.patch(
  '/:reportId/status',
  validate(reportIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.REPORT_REVIEW),
  validate(updateReportStatusSchema),
  asyncHandler(updateReportStatusHandler)
);

// ---------------------------------------------------------------------------
// Moderation actions
// ---------------------------------------------------------------------------

export const moderationRouter: Router = Router();

moderationRouter.use(requireAuth);

moderationRouter.post(
  '/actions',
  requirePermission(PERMISSIONS.MODERATION_ACTION),
  validate(createModerationActionSchema),
  asyncHandler(createModerationActionHandler)
);

moderationRouter.get(
  '/actions',
  requirePermission(PERMISSIONS.MODERATION_ACTION),
  validate(listModerationActionsQuerySchema, 'query'),
  asyncHandler(listModerationActionsHandler)
);
