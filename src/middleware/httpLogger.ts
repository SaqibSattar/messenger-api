import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export const httpLogger = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(
      (process.hrtime.bigint() - start) / 1_000_000n
    );
    logger.info(
      {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
        userId: req.user?.id
      },
      'request'
    );
  });
  next();
};
