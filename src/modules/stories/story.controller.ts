import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as storyService from './story.service';
import type {
  CreateStoryInput,
  CreateStoryMuteInput,
  ListStoriesQuery,
  ListStoryViewersQuery,
  ReportStoryInput
} from './story.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const createStoryHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateStoryInput;
  const story = await storyService.createStory(actor, input);
  created(res, { story });
};

export const listStoriesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListStoriesQuery;
  const result = await storyService.listStories(actor, query);
  ok(res, result);
};

export const getStoryHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const story = await storyService.getStory(actor, req.params.storyId);
  ok(res, { story });
};

export const markStoryViewedHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const result = await storyService.markStoryViewed(
    actor,
    req.params.storyId
  );
  ok(res, result);
};

export const listStoryViewersHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListStoryViewersQuery;
  const result = await storyService.listStoryViewers(
    actor,
    req.params.storyId,
    query
  );
  ok(res, result);
};

export const deleteStoryHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const story = await storyService.deleteStory(actor, req.params.storyId);
  ok(res, { story });
};

export const reportStoryHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as ReportStoryInput;
  const result = await storyService.reportStory(
    actor,
    req.params.storyId,
    input
  );
  ok(res, result);
};

export const createStoryMuteHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateStoryMuteInput;
  const mute = await storyService.createStoryMute(actor, input);
  created(res, { mute });
};

export const deleteStoryMuteHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  await storyService.deleteStoryMute(actor, req.params.userId);
  ok(res, { success: true });
};
