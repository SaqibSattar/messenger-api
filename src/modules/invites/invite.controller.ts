import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as inviteService from './invite.service';
import type { CreateInviteInput } from './invite.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const createInviteHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateInviteInput;
  const invite = await inviteService.createInvite(
    actor,
    req.params.conversationId,
    input
  );
  created(res, { invite });
};

export const listInvitesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const items = await inviteService.listInvitesForConversation(
    actor,
    req.params.conversationId
  );
  ok(res, { items });
};

export const revokeInviteHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  await inviteService.revokeInvite(actor, req.params.inviteId);
  ok(res, { success: true });
};

export const joinByInviteHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const result = await inviteService.joinByInviteToken(actor, req.params.token);
  ok(res, result);
};
