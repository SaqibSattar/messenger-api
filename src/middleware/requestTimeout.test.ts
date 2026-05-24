import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { requestTimeout } from './requestTimeout';
import { errorHandler } from './errorHandler';
import { requestId } from './requestId';

// A handler whose response is held until we explicitly resolve it. Using a
// shared deferral instead of an unmanaged setTimeout prevents stray timers
// from leaking across tests and racing against a response the middleware
// already sent.
const makeDeferredHandler = () => {
  let resolveResponse: ((res: Response) => void) | null = null;
  const handler = (_req: Request, res: Response) => {
    resolveResponse = (r) => {
      if (!r.writableEnded) r.json({ ok: true });
    };
    // If the middleware times us out first, the response is no longer
    // writable; we still capture the resolver so the test can flush
    // safely.
    res.on('close', () => {
      resolveResponse = null;
    });
  };
  const finish = () => {
    if (resolveResponse) resolveResponse({} as Response);
  };
  return { handler, finish };
};

const buildApp = (timeoutMs: number, handler: express.RequestHandler) => {
  const app = express();
  app.use(requestId);
  app.use(requestTimeout(timeoutMs));
  app.get('/x', handler);
  app.use(errorHandler);
  return app;
};

describe('requestTimeout middleware', () => {
  it('returns 503 REQUEST_TIMEOUT when the handler exceeds the budget', async () => {
    const { handler } = makeDeferredHandler();
    const res = await request(buildApp(10, handler)).get('/x');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'REQUEST_TIMEOUT' }
    });
  });

  it('passes through fast responses untouched', async () => {
    const fast: express.RequestHandler = (_req, res) => {
      res.json({ ok: true });
    };
    const res = await request(buildApp(500, fast)).get('/x');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('does nothing when timeoutMs is 0 (disabled)', async () => {
    // With the middleware disabled, even a slow handler must reach the
    // client — we use a short setTimeout but resolve it before the
    // request completes, never racing against a middleware response.
    const slow: express.RequestHandler = (_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) res.json({ ok: true });
      }, 25);
    };
    const res = await request(buildApp(0, slow)).get('/x');
    expect(res.status).toBe(200);
  });
});
