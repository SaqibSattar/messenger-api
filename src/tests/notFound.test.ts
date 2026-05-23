import request from 'supertest';
import { buildApp } from '../app';

const app = buildApp();

describe('Not found handler', () => {
  it('returns a 404 with NOT_FOUND code in the standard envelope', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' }
    });
    expect(res.body.error.message).toContain('/does-not-exist');
  });
});
