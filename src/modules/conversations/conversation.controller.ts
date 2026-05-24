import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as conversationService from './conversation.service';
import type {
  AddMembersInput,
  CreateDirectConversationInput,
  CreateGroupConversationInput,
  ListConversationsQuery,
  UpdateConversationInput,
  UpdateDisappearingMessagesInput,
  UpdateMemberRoleInput,
  UpdatePreferencesInput,
  UpdateReadPointerInput
} from './conversation.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const createDirectConversationHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateDirectConversationInput;
  const result = await conversationService.createDirectConversation(actor, input);
  created(res, result);
};

export const createGroupConversationHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateGroupConversationInput;
  const result = await conversationService.createGroupConversation(actor, input);
  created(res, result);
};

export const listConversationsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListConversationsQuery;
  const result = await conversationService.listMyConversations(actor, query);
  ok(res, result);
};

export const getConversationHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const result = await conversationService.getConversation(
    actor,
    req.params.conversationId
  );
  ok(res, result);
};

export const updateConversationHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdateConversationInput;
  const conversation = await conversationService.updateConversation(
    actor,
    req.params.conversationId,
    input
  );
  ok(res, { conversation });
};

export const addMembersHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as AddMembersInput;
  const result = await conversationService.addMembers(
    actor,
    req.params.conversationId,
    input
  );
  ok(res, result);
};

export const removeMemberHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  await conversationService.removeMember(
    actor,
    req.params.conversationId,
    req.params.userId
  );
  ok(res, { success: true });
};

export const updateMemberRoleHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdateMemberRoleInput;
  const member = await conversationService.updateMemberRole(
    actor,
    req.params.conversationId,
    req.params.userId,
    input
  );
  ok(res, { member });
};

export const leaveConversationHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  await conversationService.leaveConversation(
    actor,
    req.params.conversationId
  );
  ok(res, { success: true });
};

export const updateReadPointerHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdateReadPointerInput;
  const membership = await conversationService.updateReadPointer(
    actor,
    req.params.conversationId,
    input
  );
  ok(res, { membership });
};

export const updatePreferencesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdatePreferencesInput;
  const membership = await conversationService.updatePreferences(
    actor,
    req.params.conversationId,
    input
  );
  ok(res, { membership });
};

export const updateDisappearingMessagesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdateDisappearingMessagesInput;
  const conversation = await conversationService.setDisappearingMessages(
    actor,
    req.params.conversationId,
    input
  );
  ok(res, { conversation });
};
