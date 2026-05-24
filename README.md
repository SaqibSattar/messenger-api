# messenger-api

Production-grade messenger backend. Node.js + TypeScript, Express, MongoDB,
Redis, Socket.IO. See [`AGENTS.md`](AGENTS.md) for the canonical engineering
spec and security rules — this README only covers operational concerns.

---

## Quick start (local development)

```bash
# 1. Install
npm ci

# 2. Configure
cp .env.example .env
# edit .env — at minimum set JWT_ACCESS_SECRET, JWT_REFRESH_SECRET,
# STORAGE_SIGNING_SECRET (any random value is fine for dev)

# 3. Bring up MongoDB + Redis (one option of many)
docker compose up -d mongo redis

# 4. Run the API in watch mode
npm run dev
```

The server listens on `PORT` (default `3000`). Health probes:

- `GET /health` — process is up
- `GET /ready` — process is up **and** Mongo + Redis are reachable

---

## Scripts

| Script              | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | Hot-reload server via `tsx watch src/server.ts`      |
| `npm run build`     | Compile TypeScript to `dist/`                        |
| `npm start`         | Run the compiled server (`node dist/server.js`)      |
| `npm run typecheck` | `tsc --noEmit`                                       |
| `npm run lint`      | ESLint                                               |
| `npm test`          | Jest + Supertest (uses `mongodb-memory-server`)      |

---

## Project layout

```
src/
  app.ts             Express wiring (middleware, routes, error handlers)
  server.ts          Process bootstrap, lifecycle, graceful shutdown
  config/            Env loading + production validation
  db/                Mongo and Redis client lifecycles
  middleware/        auth, requestId, validation, timeouts, error handler
  modules/           One folder per feature (auth, messages, media, ...)
  sockets/           Socket.IO bootstrap, auth, presence, room logic
  jobs/              Background workers (TTL sweeps, push fan-out)
  services/          Cross-module services (realtime event bridge, ...)
  tests/             Cross-module API tests + Jest setup
  utils/             Errors, JWT, logger, metrics, audit, response shape
```

Each module follows `model.ts / routes.ts / controller.ts / service.ts /
validation.ts / test.ts` — see [`AGENTS.md`](AGENTS.md) for the rules
controllers and services must follow.

---

## Deployment

### Container build

The included [`Dockerfile`](Dockerfile) is a two-stage build:

1. **build** — installs dev deps, type-checks, lints, compiles, then prunes
   to production deps only.
2. **runtime** — `node:20-bookworm-slim`, runs as the unprivileged `node`
   user. Includes a `HEALTHCHECK` against `GET /health`.

```bash
docker build -t messenger-api:latest .
docker run --rm -p 3000:3000 --env-file .env messenger-api:latest
```

### Local stack with compose

```bash
JWT_ACCESS_SECRET=$(openssl rand -hex 32) \
JWT_REFRESH_SECRET=$(openssl rand -hex 32) \
STORAGE_SIGNING_SECRET=$(openssl rand -hex 32) \
docker compose up --build
```

`docker-compose.yml` is intended for **local stack-up only** — Mongo/Redis
run without auth or TLS and use ephemeral named volumes. Do not point it
at production.

### Process model

`src/server.ts` listens on `PORT`, attaches Socket.IO to the same HTTP
listener (no second port), and installs `SIGINT`/`SIGTERM` handlers that:

1. Stop accepting new socket connections.
2. Drain in-flight HTTP requests.
3. Close Mongo + Redis cleanly.
4. Force exit after 10s if anything hangs.

Behind a reverse proxy / load balancer set `TRUST_PROXY` to the number of
hops; otherwise rate-limit and audit IPs will reflect the proxy instead of
the real client.

---

## Production readiness checklist

Before promoting an image, confirm all of these. The startup config
validator enforces several of them and refuses to boot when violated —
the rest are the operator's responsibility.

### Secrets and config (validator-enforced)
- [ ] `NODE_ENV=production`.
- [ ] `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `STORAGE_SIGNING_SECRET`
      are strong random values and **not** the `replace-me-*` placeholders.
- [ ] `MONGODB_URI` and `REDIS_URL` are set.
- [ ] `CLIENT_ORIGIN` is a strict allowlist (comma-separated) — never `*`.
- [ ] If `STORAGE_PROVIDER=s3`: `STORAGE_BUCKET`, `STORAGE_REGION`,
      `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` are set.

### HTTP surface
- [ ] Reverse proxy terminates TLS; HTTP-only is never exposed to the
      internet.
- [ ] `TRUST_PROXY` matches the proxy hop count.
- [ ] `BODY_LIMIT` is sized for the slowest legitimate non-upload route
      (defaults to `100kb`).
- [ ] `REQUEST_TIMEOUT_MS` is set — defaults to 15 s.

### Datastores
- [ ] Mongo and Redis are reachable from the runtime (check `/ready`).
- [ ] Mongo runs with authentication enabled and uses TLS.
- [ ] Mongo replica set / change streams configured if the realtime
      bridge needs them.
- [ ] Redis has auth or runs on a private network — Socket.IO adapter
      and rate-limit counters live here.
- [ ] Backups: Mongo dumps on a known cadence; Redis state is treated as
      cache and rebuilt on restart.

### Storage
- [ ] If S3: bucket policy is private, signed-URL TTLs are short
      (`MEDIA_DOWNLOAD_URL_TTL_SECONDS` default 300s).
- [ ] If memory storage: only used in dev/test — never in production.

### Operability
- [ ] `/health` and `/ready` wired to the orchestrator's probes.
- [ ] `/metrics` accessible only to admin-token holders (route is
      `requireAuth + admin:system:read`).
- [ ] Logs go to a JSON-aware aggregator. The pino logger redacts auth
      headers, password hashes, tokens, OTPs, and `*.code` fields; do not
      add log lines that bypass this.
- [ ] Background TTL/cleanup jobs (`src/jobs/*`) are scheduled — they
      are not started by the HTTP process.

### Security smoke checks
- [ ] `curl -X OPTIONS -H 'Origin: https://evil.example' ...` does not
      get an Allow-Origin echo.
- [ ] `curl -d '{...giant body...}'` returns 413 before reaching the
      route handler.
- [ ] An expired access token is rejected with 401 on every protected
      route.
- [ ] Duplicate registration returns 409 without revealing which
      identifier (email vs phone) was taken.

---

## Testing

`npm test` runs Jest + Supertest against an in-memory MongoDB
(`mongodb-memory-server`). Redis is not required for the test suite —
modules that need Redis are stubbed or skipped in tests.

The test suite covers the security-critical surfaces called out in
`AGENTS.md`:

- auth flows (registration, login, refresh token rotation, password change)
- authorization (role + permission middleware, resource ownership)
- conversation membership
- message and disappearing-message rules
- story visibility and expiration
- media upload restrictions
- socket authentication
- global error handler, validation middleware, request timeout, CORS,
  body limit, security headers

---

## Environment variables

Use [`.env.example`](.env.example) as the reference. The startup
validator in `src/config/env.ts` will refuse to boot if a required
production variable is missing or contains a placeholder value.
