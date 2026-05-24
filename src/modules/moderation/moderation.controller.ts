import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as moderationService from './moderation.service';
import type {
  CreateModerationActionInput,
  ListModerationActionsQuery
} from './moderation.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

const auditContext = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return {
    actorId: req.user.id,
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.header('user-agent') ?? undefined
  };
};

export const createModerationActionHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateModerationActionInput;
  const action = await moderationService.createModerationAction(
    actor,
    input,
    auditContext(req)
  );
  created(res, { action });
};

export const listModerationActionsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListModerationActionsQuery;
  const result = await moderationService.listModerationActions(actor, query);
  ok(res, result);
};
