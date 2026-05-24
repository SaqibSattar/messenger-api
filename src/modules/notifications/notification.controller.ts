import type { Request, Response } from 'express';
import { ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as notificationService from './notification.service';
import type {
  ListNotificationsQuery,
  UpdateConversationNotificationPreferenceInput,
  UpdateNotificationPreferencesInput
} from './notification.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const listNotificationsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListNotificationsQuery;
  const result = await notificationService.listNotifications(actor, query);
  ok(res, result);
};

export const markNotificationReadHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const notification = await notificationService.markRead(
    actor,
    req.params.notificationId
  );
  ok(res, { notification });
};

export const markNotificationUnreadHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const notification = await notificationService.markUnread(
    actor,
    req.params.notificationId
  );
  ok(res, { notification });
};

export const markAllNotificationsReadHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const result = await notificationService.markAllRead(actor);
  ok(res, result);
};

export const getNotificationPreferencesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const preferences = await notificationService.getPreferences(actor);
  ok(res, { preferences });
};

export const updateNotificationPreferencesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdateNotificationPreferencesInput;
  const preferences = await notificationService.updatePreferences(actor, input);
  ok(res, { preferences });
};

export const getConversationNotificationPreferenceHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const preference =
    await notificationService.getConversationNotificationPreference(
      actor,
      req.params.conversationId
    );
  ok(res, { preference });
};

export const updateConversationNotificationPreferenceHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdateConversationNotificationPreferenceInput;
  const preference =
    await notificationService.updateConversationNotificationPreference(
      actor,
      req.params.conversationId,
      input
    );
  ok(res, { preference });
};
