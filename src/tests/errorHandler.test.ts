import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler';
import { BadRequestError, ValidationError } from '../utils/errors';
import { requestId } from '../middleware/requestId';

const makeApp = (handler: RequestHandler) => {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.get('/boom', handler);
  app.use(errorHandler);
  return app;
};

describe('Global error handler', () => {
  it('formats AppError responses with code and message', async () => {
    const app = makeApp((_req, _res, next) =>
      next(new BadRequestError('nope'))
    );
    const res = await request(app).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'nope' }
    });
  });

  it('returns VALIDATION_ERROR with details', async () => {
    const app = makeApp((_req, _res, next) =>
      next(new ValidationError([{ path: 'name', message: 'required' }]))
    );
    const res = await request(app).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toBeDefined();
  });

  it('handles unknown errors as 500 without leaking stack frames', async () => {
    const app = makeApp((_req, _res, next) => next(new Error('boom detail')));
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/\s+at\s+/);
  });

  it('rejects malformed JSON cleanly', async () => {
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.post('/echo', (req, res) => {
      res.json(req.body);
    });
    app.use(errorHandler);

    const res = await request(app)
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{"oops":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});
