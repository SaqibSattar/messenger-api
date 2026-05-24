import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import yaml from 'js-yaml';
import swaggerUi from 'swagger-ui-express';
import { logger } from '../utils/logger';

/**
 * Interactive API documentation.
 *
 * Mounts:
 *   - GET /docs           → Swagger UI rendered from openapi.yaml
 *   - GET /openapi.json   → spec as JSON (machine readable)
 *   - GET /openapi.yaml   → spec as YAML (the raw source of truth)
 *
 * The YAML file lives at docs/api/openapi.yaml. It is the single source
 * of truth for the OpenAPI contract; this module just loads it. If the
 * file is absent (e.g. a stripped-down container build), the routes are
 * not mounted — `/docs` then 404s like any other unrouted path. We
 * deliberately do not synthesise a placeholder spec, since a stale or
 * fake spec is more misleading than no spec at all.
 *
 * Spec content is not sensitive — it documents the same endpoints
 * already in `docs/api/REST.md`. Endpoints themselves enforce auth.
 */

const OPENAPI_PATH = path.resolve(__dirname, '..', '..', 'docs', 'api', 'openapi.yaml');

interface LoadedSpec {
  json: Record<string, unknown>;
  yaml: string;
}

let cached: LoadedSpec | null | undefined;

const loadSpec = (): LoadedSpec | null => {
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(OPENAPI_PATH, 'utf8');
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== 'object') {
      logger.warn({ path: OPENAPI_PATH }, 'openapi.yaml parsed to non-object — disabling /docs');
      cached = null;
      return null;
    }
    cached = { json: parsed as Record<string, unknown>, yaml: raw };
    return cached;
  } catch (err) {
    logger.warn({ err, path: OPENAPI_PATH }, 'openapi.yaml not found or unreadable — disabling /docs');
    cached = null;
    return null;
  }
};

export const mountApiDocs = (app: Express): void => {
  const spec = loadSpec();
  if (!spec) return;

  // Raw spec endpoints. Useful for client codegen (`openapi-generator`,
  // `openapi-typescript`, ...) and for diffing during PR review.
  app.get('/openapi.json', (_req: Request, res: Response) => {
    res.type('application/json').send(spec.json);
  });
  app.get('/openapi.yaml', (_req: Request, res: Response) => {
    res.type('text/yaml').send(spec.yaml);
  });

  // Swagger UI. The serve middleware ships its own static assets; setup
  // injects the spec into the rendered HTML. customSiteTitle keeps the
  // tab title meaningful when an integrator pins this in a browser.
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec.json, {
      customSiteTitle: 'messenger-api — API docs',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true
      }
    })
  );
};

// Reset for tests that want to exercise the load-failure branch.
export const __resetApiDocsForTests = (): void => {
  cached = undefined;
};
