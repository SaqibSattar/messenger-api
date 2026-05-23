import type {
  Request,
  Response,
  NextFunction,
  RequestHandler
} from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type { Role } from '../modules/permissions/permissions.constants';

export const requireRole = (...roles: Role[]): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError('Insufficient role'));
      return;
    }
    next();
  };
};
