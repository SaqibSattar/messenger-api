import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as blockService from './block.service';
import type {
  CreateBlockInput,
  ListBlocksQuery
} from './block.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const createBlockHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateBlockInput;
  const block = await blockService.createBlock(actor, input);
  created(res, { block });
};

export const listBlocksHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListBlocksQuery;
  const result = await blockService.listBlocks(actor, query);
  ok(res, result);
};

export const removeBlockHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  await blockService.removeBlock(actor, req.params.blockedUserId);
  ok(res, { success: true });
};
