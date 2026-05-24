import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import { toUserDto } from '../users/user.model';
import * as authService from './auth.service';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  LogoutInput,
  RefreshInput,
  RegisterInput
} from './auth.validation';

const requestContext = (req: Request) => ({
  userAgent: req.header('user-agent') ?? undefined,
  ipAddress: req.ip
});

export const registerHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const input = req.body as RegisterInput;
  const result = await authService.register(input, requestContext(req));
  created(res, result);
};

export const loginHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const input = req.body as LoginInput;
  const result = await authService.login(input, requestContext(req));
  ok(res, result);
};

export const refreshHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const input = req.body as RefreshInput;
  const tokens = await authService.refresh(input.refreshToken, requestContext(req));
  ok(res, { tokens });
};

export const logoutHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const input = req.body as LogoutInput;
  await authService.logout(input.refreshToken);
  ok(res, { success: true });
};

export const logoutAllHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const revoked = await authService.logoutAll(req.user.id, requestContext(req));
  ok(res, { revoked });
};

export const changePasswordHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const input = req.body as ChangePasswordInput;
  await authService.changePassword(req.user.id, input, requestContext(req));
  ok(res, { success: true });
};

export const forgotPasswordHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  await authService.forgotPassword(req.body as ForgotPasswordInput);
  // Always respond identically to avoid leaking whether the account exists.
  ok(res, {
    success: true,
    message: 'If the account exists, a reset link has been sent'
  });
};

export const resetPasswordHandler = async (
  _req: Request,
  _res: Response
): Promise<void> => {
  await authService.resetPassword();
};

export const meHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const user = await authService.findUserById(req.user.id);
  if (!user) throw new UnauthorizedError();
  ok(res, { user: toUserDto(user) });
};
