import type {
  Request,
  Response,
  NextFunction,
  RequestHandler
} from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import {
  hasPermission,
  type Permission
} from '../modules/permissions/permissions.constants';

export const requirePermission = (
  ...permissions: Permission[]
): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }
    const allowed = permissions.every(
      (p) => user.permissions.includes(p) || hasPermission(user.role, p)
    );
    if (!allowed) {
      next(new ForbiddenError('Insufficient permission'));
      return;
    }
    next();
  };
};
