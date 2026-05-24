import type { Request, Response } from 'express';
import { ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as searchService from './search.service';
import type {
  SearchConversationsQuery,
  SearchMessagesQuery,
  SearchUsersQuery
} from './search.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const searchConversationsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as SearchConversationsQuery;
  const result = await searchService.searchConversations(actor, query);
  ok(res, result);
};

export const searchMessagesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as SearchMessagesQuery;
  const result = await searchService.searchMessages(actor, query);
  ok(res, result);
};

export const searchUsersHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as SearchUsersQuery;
  const result = await searchService.searchUsersByText(actor, query);
  ok(res, result);
};
