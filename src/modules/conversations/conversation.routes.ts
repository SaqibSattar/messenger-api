import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  addMembersHandler,
  createDirectConversationHandler,
  createGroupConversationHandler,
  getConversationHandler,
  leaveConversationHandler,
  listConversationsHandler,
  removeMemberHandler,
  updateConversationHandler,
  updateDisappearingMessagesHandler,
  updateMemberRoleHandler,
  updatePreferencesHandler,
  updateReadPointerHandler
} from './conversation.controller';
import {
  addMembersSchema,
  conversationIdParamSchema,
  conversationMemberParamSchema,
  createDirectConversationSchema,
  createGroupConversationSchema,
  listConversationsQuerySchema,
  updateConversationSchema,
  updateDisappearingMessagesSchema,
  updateMemberRoleSchema,
  updatePreferencesSchema,
  updateReadPointerSchema
} from './conversation.validation';

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

export const conversationRouter: Router = Router();

conversationRouter.use(requireAuth);

// All conversation creation requires the route-level permission AND the
// resource-level rules in the service (membership, blocks, dedup).
conversationRouter.post(
  '/direct',
  limiter(60, 60 * 60 * 1000),
  requirePermission(PERMISSIONS.CONVERSATION_CREATE),
  validate(createDirectConversationSchema),
  asyncHandler(createDirectConversationHandler)
);

conversationRouter.post(
  '/groups',
  limiter(30, 60 * 60 * 1000),
  requirePermission(PERMISSIONS.CONVERSATION_CREATE),
  validate(createGroupConversationSchema),
  asyncHandler(createGroupConversationHandler)
);

conversationRouter.get(
  '/',
  requirePermission(PERMISSIONS.CONVERSATION_READ),
  validate(listConversationsQuerySchema, 'query'),
  asyncHandler(listConversationsHandler)
);

conversationRouter.get(
  '/:conversationId',
  validate(conversationIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.CONVERSATION_READ),
  asyncHandler(getConversationHandler)
);

conversationRouter.patch(
  '/:conversationId',
  validate(conversationIdParamSchema, 'params'),
  validate(updateConversationSchema),
  asyncHandler(updateConversationHandler)
);

conversationRouter.post(
  '/:conversationId/members',
  validate(conversationIdParamSchema, 'params'),
  validate(addMembersSchema),
  asyncHandler(addMembersHandler)
);

conversationRouter.delete(
  '/:conversationId/members/:userId',
  validate(conversationMemberParamSchema, 'params'),
  asyncHandler(removeMemberHandler)
);

conversationRouter.patch(
  '/:conversationId/members/:userId/role',
  validate(conversationMemberParamSchema, 'params'),
  validate(updateMemberRoleSchema),
  asyncHandler(updateMemberRoleHandler)
);

conversationRouter.post(
  '/:conversationId/leave',
  validate(conversationIdParamSchema, 'params'),
  asyncHandler(leaveConversationHandler)
);

conversationRouter.patch(
  '/:conversationId/read',
  validate(conversationIdParamSchema, 'params'),
  validate(updateReadPointerSchema),
  asyncHandler(updateReadPointerHandler)
);

conversationRouter.patch(
  '/:conversationId/preferences',
  validate(conversationIdParamSchema, 'params'),
  validate(updatePreferencesSchema),
  asyncHandler(updatePreferencesHandler)
);

// Disappearing-messages setting. Route-level limiter is tight because
// flipping the setting is rare and noisy clients trying to spam it should be
// throttled hard. Permission and role rules are enforced inside the service,
// not via requirePermission middleware: direct conversations need the
// member-scoped permission, groups need the group-scoped one, and the
// resource-level rule is "must actually be a member of this conversation".
conversationRouter.patch(
  '/:conversationId/disappearing-messages',
  limiter(30, 60 * 1000),
  validate(conversationIdParamSchema, 'params'),
  validate(updateDisappearingMessagesSchema),
  asyncHandler(updateDisappearingMessagesHandler)
);
