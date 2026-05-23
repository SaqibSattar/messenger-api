import type { Response } from 'express';

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const ok = <T>(
  res: Response,
  data: T,
  message?: string,
  status = 200
): Response => {
  const body: ApiSuccess<T> = { success: true, data };
  if (message) body.message = message;
  return res.status(status).json(body);
};

export const created = <T>(
  res: Response,
  data: T,
  message?: string
): Response => ok(res, data, message, 201);

export const fail = (
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
): Response => {
  const body: ApiError = {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {})
    }
  };
  return res.status(status).json(body);
};
