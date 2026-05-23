import type {
  Request,
  Response,
  NextFunction,
  RequestHandler
} from 'express';
import type { ZodSchema } from 'zod';

type Source = 'body' | 'query' | 'params';

export const validate = (
  schema: ZodSchema,
  source: Source = 'body'
): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(result.error);
      return;
    }
    (req as unknown as Record<Source, unknown>)[source] = result.data;
    next();
  };
};
