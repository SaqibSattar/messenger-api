import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

export const requestId = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id =
    incoming && /^[a-zA-Z0-9-_]{1,128}$/.test(incoming)
      ? incoming
      : randomUUID();
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};
