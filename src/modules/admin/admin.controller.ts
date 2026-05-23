import type { Request, Response } from 'express';
import { ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as adminService from './admin.service';
import type {
  UpdateCustomPermissionsInput,
  UpdateRoleInput
} from './admin.validation';

const auditContext = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return {
    actorId: req.user.id,
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.header('user-agent') ?? undefined
  };
};

export const updateUserRoleHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const input = req.body as UpdateRoleInput;
  const user = await adminService.updateUserRole(
    req.user,
    req.params.userId,
    input,
    auditContext(req)
  );
  ok(res, { user });
};

export const updateUserCustomPermissionsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) throw new UnauthorizedError();
  const input = req.body as UpdateCustomPermissionsInput;
  const user = await adminService.updateUserCustomPermissions(
    req.user,
    req.params.userId,
    input,
    auditContext(req)
  );
  ok(res, { user });
};
