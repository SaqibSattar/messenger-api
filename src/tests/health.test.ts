import request from 'supertest';
import { buildApp } from '../app';

const app = buildApp();

describe('GET /health', () => {
  it('returns success with uptime', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('up');
    expect(typeof res.body.data.uptime).toBe('number');
  });

  it('sets an x-request-id response header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[a-zA-Z0-9-_]+$/);
  });

  it('echoes a safe inbound x-request-id', async () => {
    const res = await request(app)
      .get('/health')
      .set('x-request-id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});

describe('GET /ready', () => {
  it('returns 503 when dependencies are not connected', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.data.checks).toEqual({ mongo: false, redis: false });
  });
});
