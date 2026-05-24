import request from 'supertest';
import { buildApp } from '../app';

const app = buildApp();

describe('app hardening', () => {
  describe('security headers (helmet)', () => {
    it('sets baseline security headers and strips x-powered-by', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
      // Helmet's defaults — assert on the strict pieces we explicitly
      // opted into, not the entire response.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toContain(
        "default-src 'none'"
      );
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'"
      );
    });
  });

  describe('CORS', () => {
    it('accepts requests with no Origin (same-origin / non-browser callers)', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });

    it('echoes the allowlisted origin and exposes the request-id header', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:5173');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173'
      );
      expect(res.headers['access-control-expose-headers']).toContain(
        'x-request-id'
      );
    });

    it('rejects a disallowed origin', async () => {
      // The CORS middleware sends an error to the global handler, which
      // surfaces as 500 (a non-allowlisted origin should never see CORS
      // headers letting it through).
      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://evil.example.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('body limits', () => {
    it('rejects oversized JSON bodies with 413 PAYLOAD_TOO_LARGE', async () => {
      // The default limit is 100kb; ship a clearly-over-limit payload.
      const payload = { junk: 'x'.repeat(200_000) };
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send(payload);
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('error responses', () => {
    it('never leaks stack frames on 404s', async () => {
      const res = await request(app).get('/totally-missing-route');
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/\s+at\s+\S+:\d+:\d+/);
    });
  });

  describe('/metrics route', () => {
    it('rejects unauthenticated callers — never publicly scrapable', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
    });
  });
});
