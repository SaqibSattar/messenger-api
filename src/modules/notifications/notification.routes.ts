import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  getConversationNotificationPreferenceHandler,
  getNotificationPreferencesHandler,
  listNotificationsHandler,
  markAllNotificationsReadHandler,
  markNotificationReadHandler,
  markNotificationUnreadHandler,
  updateConversationNotificationPreferenceHandler,
  updateNotificationPreferencesHandler
} from './notification.controller';
import {
  conversationNotificationPreferenceParamSchema,
  listNotificationsQuerySchema,
  notificationIdParamSchema,
  updateConversationNotificationPreferenceSchema,
  updateNotificationPreferencesSchema
} from './notification.validation';

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
// /api/v1/notifications
// ---------------------------------------------------------------------------

export const notificationRouter: Router = Router();

notificationRouter.use(requireAuth);

notificationRouter.get(
  '/',
  requirePermission(PERMISSIONS.NOTIFICATION_READ_OWN),
  validate(listNotificationsQuerySchema, 'query'),
  asyncHandler(listNotificationsHandler)
);

notificationRouter.patch(
  '/:notificationId/read',
  requirePermission(PERMISSIONS.NOTIFICATION_READ_OWN),
  validate(notificationIdParamSchema, 'params'),
  asyncHandler(markNotificationReadHandler)
);

notificationRouter.patch(
  '/:notificationId/unread',
  requirePermission(PERMISSIONS.NOTIFICATION_READ_OWN),
  validate(notificationIdParamSchema, 'params'),
  asyncHandler(markNotificationUnreadHandler)
);

// Bulk mark-all-read. Tight per-user limiter — this is the kind of operation
// a noisy client could spam to no end.
notificationRouter.post(
  '/read-all',
  limiter(30, 60 * 1000),
  requirePermission(PERMISSIONS.NOTIFICATION_READ_OWN),
  asyncHandler(markAllNotificationsReadHandler)
);

// ---------------------------------------------------------------------------
// /api/v1/notification-preferences
// ---------------------------------------------------------------------------

export const notificationPreferencesRouter: Router = Router();

notificationPreferencesRouter.use(requireAuth);

notificationPreferencesRouter.get(
  '/',
  requirePermission(PERMISSIONS.NOTIFICATION_MANAGE_OWN),
  asyncHandler(getNotificationPreferencesHandler)
);

notificationPreferencesRouter.patch(
  '/',
  limiter(60, 60 * 1000),
  requirePermission(PERMISSIONS.NOTIFICATION_MANAGE_OWN),
  validate(updateNotificationPreferencesSchema),
  asyncHandler(updateNotificationPreferencesHandler)
);

// ---------------------------------------------------------------------------
// /api/v1/conversations/:conversationId/notification-preferences
//
// Mounted as a child router so it inherits the parent's :conversationId
// param. Membership is enforced inside the service (resource-level rule),
// not via requirePermission middleware, because the permission to manage
// notification settings is platform-wide while membership is per-conversation.
// ---------------------------------------------------------------------------

export const conversationNotificationPreferencesRouter: Router = Router({
  mergeParams: true
});

conversationNotificationPreferencesRouter.use(requireAuth);

conversationNotificationPreferencesRouter.get(
  '/',
  requirePermission(PERMISSIONS.NOTIFICATION_MANAGE_OWN),
  validate(conversationNotificationPreferenceParamSchema, 'params'),
  asyncHandler(getConversationNotificationPreferenceHandler)
);

conversationNotificationPreferencesRouter.patch(
  '/',
  limiter(60, 60 * 1000),
  requirePermission(PERMISSIONS.NOTIFICATION_MANAGE_OWN),
  validate(conversationNotificationPreferenceParamSchema, 'params'),
  validate(updateConversationNotificationPreferenceSchema),
  asyncHandler(updateConversationNotificationPreferenceHandler)
);
