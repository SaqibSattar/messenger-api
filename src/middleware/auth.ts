import type { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from '../utils/errors';
import { verifyAccessToken } from '../utils/jwt';
import { User } from '../modules/users/user.model';
import { USER_STATUS } from '../modules/users/user.types';
import {
  resolveEffectivePermissions,
  type Role
} from '../modules/permissions/permissions.constants';

export const requireAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const header = req.header('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    next(new UnauthorizedError());
    return;
  }
  const token = header.slice(7).trim();
  if (!token) {
    next(new UnauthorizedError());
    return;
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    next(new UnauthorizedError('Invalid or expired token'));
    return;
  }

  try {
    const user = await User.findById(payload.sub).select('+passwordChangedAt');
    // Allow ACTIVE through normally. PENDING_DELETION is allowed so the user
    // can still cancel the deletion (and reach /me + /me/delete-cancel +
    // /me/data-export) during the grace window — but a delete-request also
    // revokes every existing session, so any token reaching this branch was
    // issued *after* the request via a deliberate re-login.
    if (
      !user ||
      (user.status !== USER_STATUS.ACTIVE &&
        user.status !== USER_STATUS.PENDING_DELETION)
    ) {
      next(new UnauthorizedError());
      return;
    }

    // Token issued before the user's password change is no longer trusted.
    if (
      user.passwordChangedAt &&
      typeof payload.iat === 'number' &&
      payload.iat * 1000 < user.passwordChangedAt.getTime()
    ) {
      next(new UnauthorizedError('Token is no longer valid'));
      return;
    }

    const role = user.role as Role;
    req.user = {
      id: user._id.toString(),
      role,
      permissions: resolveEffectivePermissions(role, user.customPermissions)
    };
    next();
  } catch (err) {
    next(err);
  }
};
