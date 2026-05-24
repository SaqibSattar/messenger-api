import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError } from '../utils/errors';

class RequestTimeoutError extends AppError {
  constructor() {
    super(503, 'REQUEST_TIMEOUT', 'Request processing took too long');
  }
}

// Hard upper bound on how long an HTTP request may stay open in the
// application layer. Hung requests pin connections, file descriptors, and
// (with concurrent uploads) memory — a single misbehaving client should
// not be able to drain the pool. Routes that legitimately take longer
// (background-style operations) should run as jobs instead of stretching
// the request lifecycle.
export const requestTimeout = (timeoutMs: number): RequestHandler => {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (timeoutMs <= 0) {
      next();
      return;
    }
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      next(new RequestTimeoutError());
    }, timeoutMs);
    // Avoid pinning the event loop in long-lived listen scenarios.
    timer.unref();
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  };
};
