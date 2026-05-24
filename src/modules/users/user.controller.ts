import type { Request, Response } from 'express';
import { ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as userService from './user.service';
import type {
  DeactivateAccountInput,
  SearchUsersInput,
  UpdateProfileInput
} from './user.validation';

export const getMeHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const user = await userService.getMe(req.user.id);
  ok(res, { user });
};

export const updateMeHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const input = req.body as UpdateProfileInput;
  const user = await userService.updateMe(req.user.id, input);
  ok(res, { user });
};

export const getPublicProfileHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const user = await userService.getPublicProfile(req.params.userId);
  ok(res, { user });
};

export const searchUsersHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const input = req.query as unknown as SearchUsersInput;
  const users = await userService.searchUsers(input);
  ok(res, { users });
};

export const deactivateMeHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const input = req.body as DeactivateAccountInput;
  await userService.deactivateAccount(req.user.id, input);
  ok(res, { success: true });
};
