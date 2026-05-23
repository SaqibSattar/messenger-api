import type { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from '../utils/errors';

// Placeholder. Real JWT verification + user hydration lands in module 02
// (02-auth-and-sessions.md). For now this rejects every request so route
// wiring can be exercised without leaking access; do not soften it.
export const requireAuth = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const header = req.header('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    next(new UnauthorizedError());
    return;
  }
  next(new UnauthorizedError('Token verification not yet implemented'));
};
