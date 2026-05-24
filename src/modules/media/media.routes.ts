import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  completeUploadHandler,
  createUploadUrlHandler,
  deleteAttachmentHandler,
  getAttachmentHandler
} from './media.controller';
import {
  attachmentIdParamSchema,
  completeUploadSchema,
  createUploadUrlSchema
} from './media.validation';

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

export const mediaRouter: Router = Router();

mediaRouter.use(requireAuth);

// Tight cap on signed-URL issuance. Each call creates a Mongo document and
// burns an upload token, so abuse here translates into orphan rows and
// cleanup work.
mediaRouter.post(
  '/upload-url',
  limiter(60, 60 * 1000),
  requirePermission(PERMISSIONS.MEDIA_CREATE),
  validate(createUploadUrlSchema),
  asyncHandler(createUploadUrlHandler)
);

mediaRouter.post(
  '/complete',
  limiter(120, 60 * 1000),
  requirePermission(PERMISSIONS.MEDIA_CREATE),
  validate(completeUploadSchema),
  asyncHandler(completeUploadHandler)
);

// Read needs both the route-level permission AND the resource-level checks
// inside the service. Without the service-level membership check, a token
// with media:read could read any attachment by guessing its id.
mediaRouter.get(
  '/:attachmentId',
  validate(attachmentIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.MEDIA_READ),
  asyncHandler(getAttachmentHandler)
);

mediaRouter.delete(
  '/:attachmentId',
  validate(attachmentIdParamSchema, 'params'),
  asyncHandler(deleteAttachmentHandler)
);
