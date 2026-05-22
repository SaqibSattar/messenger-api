# Prompt 01: Project Foundation

You are an expert Node.js, TypeScript, MongoDB, Redis, and production security engineer.

Build or improve the project foundation for a production-grade messenger backend. Before coding, inspect the existing repo structure, package scripts, configuration files, and current conventions. Follow the existing style when present.

## Goal

Create a secure, maintainable backend foundation that future messenger modules can build on.

## Required Stack

- Node.js
- TypeScript
- Express.js or Fastify
- MongoDB with Mongoose
- Redis
- Zod or Joi for validation
- JWT-ready auth foundation
- Helmet
- strict CORS
- structured logging with Pino or Winston
- Jest/Supertest or the existing test stack

Do not add a major dependency without explaining why.

## Implement Or Improve

- app/server entrypoint separation
- centralized environment config with validation
- MongoDB connection module
- Redis connection module
- centralized logger
- request ID middleware
- security headers
- strict CORS allowlist
- JSON body size limits
- global error handler
- not-found handler
- health and readiness endpoints
- consistent API response shape
- reusable async handler
- base validation middleware
- base auth middleware placeholder if auth is not implemented yet
- base permission middleware placeholder if permissions are not implemented yet
- shared role and permission constants
- reusable `requireAuth`, `requireRole`, and `requirePermission` middleware shape
- folder structure for modules

Recommended structure:

```txt
src/
  app.ts
  server.ts
  config/
  db/
  middleware/
  modules/
    permissions/
  sockets/
  utils/
  types/
  tests/
```

## Security Requirements

- never hardcode secrets
- validate environment variables at startup
- no wildcard CORS in production
- no stack traces in production responses
- set safe request body limits
- log safely without tokens or private data
- reject malformed JSON cleanly

## Permission Foundation

Add a clear foundation for authorization and permissions even if the full permission module is implemented later.

Create or reserve patterns for:

- system roles such as `member`, `moderator`, `admin`, and `super-admin`
- permission names such as `conversation:read`, `conversation:manage`, `message:moderate`, `media:read`, `report:review`, and `admin:audit:read`
- route-level permission middleware
- resource-level authorization helpers
- ownership checks
- conversation membership checks
- group role checks

Important: route-level permissions are not enough for a messenger app. Also add resource-level checks so a user with a valid token cannot access another user's private conversation, message, report, attachment, or notification.

## Health Endpoints

Add:

```txt
GET /health
GET /ready
```

`/health` should confirm the server is running.

`/ready` should verify required dependencies such as MongoDB and Redis.

## Testing

Add tests for:

- health endpoint
- readiness endpoint
- not-found handler
- global error handler
- validation middleware if added
- base permission middleware if added

## Done Criteria

- project starts successfully
- config fails fast for missing production secrets
- permission middleware and constants are ready for future modules
- lint/typecheck pass
- tests pass
- README or `.env.example` is updated for new environment variables
