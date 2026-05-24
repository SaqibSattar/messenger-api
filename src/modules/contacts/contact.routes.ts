import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  acceptContactRequestHandler,
  cancelContactRequestHandler,
  createContactRequestHandler,
  declineContactRequestHandler,
  listContactsHandler,
  listIncomingContactRequestsHandler,
  listOutgoingContactRequestsHandler,
  removeContactHandler
} from './contact.controller';
import {
  contactRequestIdParamSchema,
  contactUserIdParamSchema,
  createContactRequestSchema,
  listContactRequestsQuerySchema,
  listContactsQuerySchema
} from './contact.validation';

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

export const contactRouter: Router = Router();

contactRouter.use(requireAuth);

// Sending contact requests is a classic abuse surface — spam an inbox with
// thousands of requests. Cap creation hard; the per-day side-effect is
// further limited by the partial-unique index on (sender, receiver).
contactRouter.post(
  '/requests',
  limiter(30, 60 * 60 * 1000),
  requirePermission(PERMISSIONS.CONTACT_CREATE),
  validate(createContactRequestSchema),
  asyncHandler(createContactRequestHandler)
);

contactRouter.get(
  '/requests/incoming',
  requirePermission(PERMISSIONS.CONTACT_READ),
  validate(listContactRequestsQuerySchema, 'query'),
  asyncHandler(listIncomingContactRequestsHandler)
);

contactRouter.get(
  '/requests/outgoing',
  requirePermission(PERMISSIONS.CONTACT_READ),
  validate(listContactRequestsQuerySchema, 'query'),
  asyncHandler(listOutgoingContactRequestsHandler)
);

contactRouter.post(
  '/requests/:requestId/accept',
  validate(contactRequestIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.CONTACT_MANAGE_OWN),
  asyncHandler(acceptContactRequestHandler)
);

contactRouter.post(
  '/requests/:requestId/decline',
  validate(contactRequestIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.CONTACT_MANAGE_OWN),
  asyncHandler(declineContactRequestHandler)
);

contactRouter.delete(
  '/requests/:requestId',
  validate(contactRequestIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.CONTACT_MANAGE_OWN),
  asyncHandler(cancelContactRequestHandler)
);

contactRouter.get(
  '/',
  requirePermission(PERMISSIONS.CONTACT_READ),
  validate(listContactsQuerySchema, 'query'),
  asyncHandler(listContactsHandler)
);

contactRouter.delete(
  '/:userId',
  validate(contactUserIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.CONTACT_MANAGE_OWN),
  asyncHandler(removeContactHandler)
);
