import type { Request, Response } from 'express';
import { ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as userService from './user.service';
import * as accountLifecycle from '../privacy/accountLifecycle.service';
import type {
  DeactivateAccountInput,
  RequestDeletionInput,
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
  // Viewer id is optional — when the request is authenticated we use it for
  // the audience-scoped privacy gate on avatar visibility.
  const user = await userService.getPublicProfile(
    req.params.userId,
    req.user?.id
  );
  ok(res, { user });
};

export const searchUsersHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const input = req.query as unknown as SearchUsersInput;
  const users = await userService.searchUsers(input, req.user.id);
  ok(res, { users });
};

export const deactivateMeHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const input = req.body as DeactivateAccountInput;
  await userService.deactivateAccount(req.user.id, input, {
    userAgent: req.header('user-agent') ?? undefined,
    ipAddress: req.ip
  });
  ok(res, { success: true });
};

const requestContextFrom = (req: Request) => ({
  userAgent: req.header('user-agent') ?? undefined,
  ipAddress: req.ip
});

export const requestDeleteMeHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const input = req.body as RequestDeletionInput;
  const result = await accountLifecycle.requestAccountDeletion(
    req.user,
    input,
    requestContextFrom(req)
  );
  ok(res, result);
};

export const cancelDeleteMeHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const result = await accountLifecycle.cancelAccountDeletion(
    req.user,
    requestContextFrom(req)
  );
  ok(res, result);
};

export const dataExportMeHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const dump = await accountLifecycle.exportMyData(
    req.user,
    requestContextFrom(req)
  );
  // Surfaced under `data` per the standard envelope. Clients may download as
  // JSON directly; an "attachment" content disposition is not necessary
  // because the body is wrapped in the standard success shape.
  ok(res, dump);
};
