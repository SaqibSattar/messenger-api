// Contract-shape tests for the public API surface. These exist to catch
// accidental drift in the response/error/pagination shapes documented in
// docs/api/ — a failing test here means someone changed the contract.
//
// We exercise small, real routes from buildApp() rather than mocking the
// response helpers in isolation, so the tests cover the integration of
// validate → controller → ok()/fail() → errorHandler → wire JSON.

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { buildApp } from '../app';
import { errorHandler } from '../middleware/errorHandler';
import { requestId } from '../middleware/requestId';
import { validate } from '../middleware/validate';
import { ok, created, fail } from '../utils/apiResponse';
import { paginated } from '../utils/pagination';
import { ERROR_CODES } from '../utils/errorCodes';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError
} from '../utils/errors';

const app = buildApp();

describe('Success response shape', () => {
  it('ok() returns { success: true, data }', () => {
    const helperApp = express();
    helperApp.get('/x', (_req, res) => {
      ok(res, { ping: 'pong' });
    });
    return request(helperApp)
      .get('/x')
      .then((res) => {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: { ping: 'pong' } });
      });
  });

  it('ok() includes optional message when provided', () => {
    const helperApp = express();
    helperApp.get('/x', (_req, res) => {
      ok(res, { a: 1 }, 'all good');
    });
    return request(helperApp)
      .get('/x')
      .then((res) => {
        expect(res.body).toEqual({
          success: true,
          data: { a: 1 },
          message: 'all good'
        });
      });
  });

  it('created() returns status 201 with the success shape', () => {
    const helperApp = express();
    helperApp.post('/x', (_req, res) => {
      created(res, { id: 'abc' });
    });
    return request(helperApp)
      .post('/x')
      .then((res) => {
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ success: true, data: { id: 'abc' } });
      });
  });

  it('real /health endpoint matches the success shape', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.error).toBeUndefined();
  });
});

describe('Error response shape', () => {
  const makeApp = (handler: RequestHandler) => {
    const a = express();
    a.use(requestId);
    a.use(express.json());
    a.get('/boom', handler);
    a.use(errorHandler);
    return a;
  };

  const assertErrorShape = (body: unknown): void => {
    expect(body).toMatchObject({
      success: false,
      error: {
        code: expect.any(String),
        message: expect.any(String)
      }
    });
    // No success-only fields leak through on errors.
    expect((body as { data?: unknown }).data).toBeUndefined();
  };

  it.each([
    ['BadRequestError', () => new BadRequestError('nope'), 400, ERROR_CODES.BAD_REQUEST],
    ['UnauthorizedError', () => new UnauthorizedError(), 401, ERROR_CODES.UNAUTHORIZED],
    ['ForbiddenError', () => new ForbiddenError(), 403, ERROR_CODES.FORBIDDEN],
    ['NotFoundError', () => new NotFoundError(), 404, ERROR_CODES.NOT_FOUND],
    ['ConflictError', () => new ConflictError(), 409, ERROR_CODES.CONFLICT],
    ['TooManyRequestsError', () => new TooManyRequestsError(), 429, ERROR_CODES.RATE_LIMITED]
  ])('maps %s to status %d with code %s', async (_name, build, status, code) => {
    const a = makeApp((_req, _res, next) => next(build()));
    const res = await request(a).get('/boom');
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    assertErrorShape(res.body);
  });

  it('ValidationError carries a details field', async () => {
    const a = makeApp((_req, _res, next) =>
      next(new ValidationError([{ path: 'name', message: 'required' }]))
    );
    const res = await request(a).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(res.body.error.details).toBeDefined();
  });

  it('Zod schema failure surfaces as VALIDATION_ERROR with flattened details', async () => {
    const a = express();
    a.use(requestId);
    a.use(express.json());
    a.post(
      '/echo',
      validate(z.object({ name: z.string().min(1) })),
      (req, res) => {
        ok(res, req.body);
      }
    );
    a.use(errorHandler);

    const res = await request(a).post('/echo').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(res.body.error.details).toMatchObject({
      formErrors: expect.any(Array),
      fieldErrors: expect.any(Object)
    });
  });

  it('malformed JSON returns INVALID_JSON', async () => {
    const a = express();
    a.use(requestId);
    a.use(express.json());
    a.post('/echo', (req, res) => {
      res.json(req.body);
    });
    a.use(errorHandler);
    const res = await request(a)
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{"oops":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ERROR_CODES.INVALID_JSON);
    assertErrorShape(res.body);
  });

  it('unknown server error returns INTERNAL_ERROR without leaking a stack', async () => {
    const a = makeApp((_req, _res, next) => next(new Error('secret detail')));
    const res = await request(a).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(JSON.stringify(res.body)).not.toMatch(/\s+at\s+/);
    assertErrorShape(res.body);
  });

  it('fail() helper produces the contract error shape', () => {
    const a = express();
    a.get('/x', (_req, res) => {
      fail(res, 418, 'BAD_REQUEST', 'I am a teapot', { extra: 'context' });
    });
    return request(a)
      .get('/x')
      .then((res) => {
        expect(res.status).toBe(418);
        expect(res.body).toEqual({
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'I am a teapot',
            details: { extra: 'context' }
          }
        });
      });
  });

  it('real 404 route hits the centralized handler with NOT_FOUND code', async () => {
    const res = await request(app).get('/api/v1/this-route-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('real 401 returns UNAUTHORIZED on a protected route without a token', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ERROR_CODES.UNAUTHORIZED);
  });
});

describe('Error code catalogue', () => {
  it('every AppError subclass uses a code from the public catalogue', () => {
    const codes = new Set(Object.values(ERROR_CODES));
    const samples: AppError[] = [
      new BadRequestError(),
      new ValidationError([]),
      new UnauthorizedError(),
      new ForbiddenError(),
      new NotFoundError(),
      new ConflictError(),
      new TooManyRequestsError()
    ];
    for (const err of samples) {
      expect(codes.has(err.code as (typeof ERROR_CODES)[keyof typeof ERROR_CODES]))
        .toBe(true);
    }
  });
});

describe('Pagination shape', () => {
  it('paginated() returns { items, nextCursor: null } when there is no next page', () => {
    expect(paginated([1, 2, 3], null)).toEqual({
      items: [1, 2, 3],
      nextCursor: null
    });
  });

  it('paginated() carries an opaque cursor string for the next page', () => {
    expect(paginated(['a'], '65f0abcd1234567890abcdef')).toEqual({
      items: ['a'],
      nextCursor: '65f0abcd1234567890abcdef'
    });
  });

  it('serializes as the documented contract over the wire', async () => {
    const a = express();
    a.get('/list', (_req, res) => {
      ok(res, paginated([{ id: '1' }, { id: '2' }], '2'));
    });
    const res = await request(a).get('/list');
    expect(res.body).toEqual({
      success: true,
      data: {
        items: [{ id: '1' }, { id: '2' }],
        nextCursor: '2'
      }
    });
    // No extra envelope fields (no pageInfo, no total, no offset).
    expect(Object.keys(res.body.data).sort()).toEqual(['items', 'nextCursor']);
  });
});
