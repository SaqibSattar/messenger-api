import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { validate } from './validate';
import { errorHandler } from './errorHandler';
import { requestId } from './requestId';

describe('validate middleware', () => {
  const schema = z.object({
    name: z.string().min(2),
    age: z.number().int().nonnegative()
  });

  const buildApp = () => {
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.post(
      '/echo',
      validate(schema),
      (req: Request, res: Response) => {
        res.json({ received: req.body });
      }
    );
    app.use(errorHandler);
    return app;
  };

  it('passes validated and coerced payloads through to the handler', async () => {
    const res = await request(buildApp())
      .post('/echo')
      .send({ name: 'Alice', age: 30 });
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ name: 'Alice', age: 30 });
  });

  it('rejects invalid payloads with VALIDATION_ERROR and detail breakdown', async () => {
    const res = await request(buildApp())
      .post('/echo')
      .send({ name: 'A', age: -1 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toBeDefined();
  });

  it('rejects missing required fields without leaking the original payload', async () => {
    const res = await request(buildApp()).post('/echo').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // The response must never echo the raw request body — error details
    // describe the schema failure, not the attempt.
    expect(JSON.stringify(res.body)).not.toContain('"received"');
  });
});
