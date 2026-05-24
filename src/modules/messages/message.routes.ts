import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  addReactionHandler,
  deleteMessageHandler,
  editMessageHandler,
  expireMessageNowHandler,
  getMessageHandler,
  listMessagesHandler,
  markDeliveredHandler,
  markReadHandler,
  removeReactionHandler,
  sendMessageHandler
} from './message.controller';
import {
  addReactionSchema,
  conversationIdParamSchema,
  editMessageSchema,
  listMessagesQuerySchema,
  messageIdParamSchema,
  messageReactionParamSchema,
  sendMessageSchema
} from './message.validation';

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
// Conversation-nested router: /api/v1/conversations/:conversationId/messages
// mergeParams lets the param validator see :conversationId inherited from
// the parent mount.
// ---------------------------------------------------------------------------

export const conversationMessagesRouter: Router = Router({ mergeParams: true });

conversationMessagesRouter.use(requireAuth);

conversationMessagesRouter.post(
  '/',
  // Tight ceiling on outbound message rate. Per-IP is the express-rate-limit
  // default; once Redis arrives this will switch to per-userId.
  limiter(120, 60 * 1000),
  validate(conversationIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.MESSAGE_CREATE),
  validate(sendMessageSchema),
  asyncHandler(sendMessageHandler)
);

conversationMessagesRouter.get(
  '/',
  validate(conversationIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.CONVERSATION_READ),
  validate(listMessagesQuerySchema, 'query'),
  asyncHandler(listMessagesHandler)
);

// ---------------------------------------------------------------------------
// Standalone message router: /api/v1/messages/...
// ---------------------------------------------------------------------------

export const messageRouter: Router = Router();

messageRouter.use(requireAuth);

messageRouter.get(
  '/:messageId',
  validate(messageIdParamSchema, 'params'),
  requirePermission(PERMISSIONS.CONVERSATION_READ),
  asyncHandler(getMessageHandler)
);

messageRouter.patch(
  '/:messageId',
  validate(messageIdParamSchema, 'params'),
  validate(editMessageSchema),
  asyncHandler(editMessageHandler)
);

messageRouter.delete(
  '/:messageId',
  validate(messageIdParamSchema, 'params'),
  asyncHandler(deleteMessageHandler)
);

messageRouter.post(
  '/:messageId/reactions',
  limiter(180, 60 * 1000),
  validate(messageIdParamSchema, 'params'),
  validate(addReactionSchema),
  asyncHandler(addReactionHandler)
);

messageRouter.delete(
  '/:messageId/reactions/:reactionId',
  validate(messageReactionParamSchema, 'params'),
  asyncHandler(removeReactionHandler)
);

messageRouter.post(
  '/:messageId/delivered',
  validate(messageIdParamSchema, 'params'),
  asyncHandler(markDeliveredHandler)
);

messageRouter.post(
  '/:messageId/read',
  validate(messageIdParamSchema, 'params'),
  asyncHandler(markReadHandler)
);

// Force-expire one message. Only the sender (with delete-own) or a platform
// moderator can hit this — service enforces the rule. Limiter is tight: this
// is an admin/owner cleanup tool, not a hot path.
messageRouter.post(
  '/:messageId/expire-now',
  limiter(30, 60 * 1000),
  validate(messageIdParamSchema, 'params'),
  asyncHandler(expireMessageNowHandler)
);
