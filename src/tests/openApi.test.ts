import request from 'supertest';
import { buildApp } from '../app';

// Smoke tests for the OpenAPI / Swagger UI surface. The spec content is
// not validated here — the file itself is the canonical artifact, not a
// regenerated representation, so a content test would just be reading
// the file back to itself. What we *do* care about: the endpoints mount
// when the YAML exists, return the expected content type, and the spec
// is parseable JSON.

const app = buildApp();

describe('OpenAPI / docs surface', () => {
  it('serves the OpenAPI spec as JSON', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(typeof res.body.paths).toBe('object');
    // A handful of known paths must exist — guards against an empty or
    // partial spec being shipped.
    expect(res.body.paths['/api/v1/auth/login']).toBeDefined();
    expect(res.body.paths['/api/v1/conversations']).toBeDefined();
    expect(res.body.paths['/health']).toBeDefined();
  });

  it('serves the OpenAPI spec as YAML', async () => {
    const res = await request(app).get('/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
    expect(res.text).toMatch(/^openapi:\s*3\./m);
  });

  it('serves the Swagger UI shell at /docs', async () => {
    // swagger-ui-express redirects /docs → /docs/ (trailing slash); follow.
    const res = await request(app).get('/docs/').buffer(true);
    expect([200, 301, 302]).toContain(res.status);
    // The HTML page contains the Swagger UI bootstrap.
    if (res.status === 200) {
      expect(res.text).toMatch(/swagger-ui/i);
    }
  });
});
