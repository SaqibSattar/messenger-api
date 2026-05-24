import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { ERROR_CODES } from '../utils/errorCodes';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  if (err instanceof SyntaxError && 'body' in (err as unknown as Record<string, unknown>)) {
    res.status(400).json({
      success: false,
      error: {
        code: ERROR_CODES.INVALID_JSON,
        message: 'Malformed JSON in request body'
      }
    });
    return;
  }

  // express.json / express.urlencoded surface "PayloadTooLargeError"
  // (type === 'entity.too.large') when the request exceeds BODY_LIMIT.
  // Convert to a stable 413 so the body-limit becomes a real hardening
  // boundary the client can act on, rather than a generic 500.
  if (
    err instanceof Error &&
    (err as { type?: string }).type === 'entity.too.large'
  ) {
    res.status(413).json({
      success: false,
      error: {
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        message: 'Request body exceeds the configured limit'
      }
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Invalid request',
        details: err.flatten()
      }
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error(
        { err, requestId: req.id, route: req.originalUrl },
        err.message
      );
    }
    res.status(err.status).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {})
      }
    });
    return;
  }

  const error = err instanceof Error ? err : new Error('Unknown error');
  logger.error(
    { err: error, requestId: req.id, route: req.originalUrl },
    'Unhandled error'
  );

  res.status(500).json({
    success: false,
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: env.isProd ? 'Internal server error' : error.message
    }
  });
};
