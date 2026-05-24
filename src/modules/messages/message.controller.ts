import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as messageService from './message.service';
import type {
  AddReactionInput,
  EditMessageInput,
  ListMessagesQuery,
  SendMessageInput
} from './message.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const sendMessageHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as SendMessageInput;
  const message = await messageService.sendMessage(
    actor,
    req.params.conversationId,
    input
  );
  created(res, { message });
};

export const listMessagesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListMessagesQuery;
  const result = await messageService.listMessages(
    actor,
    req.params.conversationId,
    query
  );
  ok(res, result);
};

export const getMessageHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const message = await messageService.getMessage(actor, req.params.messageId);
  ok(res, { message });
};

export const editMessageHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as EditMessageInput;
  const message = await messageService.editMessage(
    actor,
    req.params.messageId,
    input
  );
  ok(res, { message });
};

export const deleteMessageHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const message = await messageService.deleteMessage(
    actor,
    req.params.messageId
  );
  ok(res, { message });
};

export const addReactionHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as AddReactionInput;
  const reaction = await messageService.addReaction(
    actor,
    req.params.messageId,
    input
  );
  created(res, { reaction });
};

export const removeReactionHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  await messageService.removeReaction(
    actor,
    req.params.messageId,
    req.params.reactionId
  );
  ok(res, { success: true });
};

export const markDeliveredHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const receipt = await messageService.markDelivered(
    actor,
    req.params.messageId
  );
  ok(res, { receipt });
};

export const markReadHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const receipt = await messageService.markRead(actor, req.params.messageId);
  ok(res, { receipt });
};

export const expireMessageNowHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const message = await messageService.expireMessageNow(
    actor,
    req.params.messageId
  );
  ok(res, { message });
};
