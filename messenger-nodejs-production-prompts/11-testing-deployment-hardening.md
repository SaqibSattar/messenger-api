# Prompt 11: Testing, Deployment, And Hardening

You are an expert production readiness engineer.

Inspect the current messenger backend and harden it for production. Focus on tests, CI readiness, deployment safety, security headers, environment validation, and operational documentation.

## Goal

Prepare the backend for reliable production deployment.

## Required Improvements

- test setup for unit/integration/API tests
- isolated test database config
- lint/typecheck scripts
- build script
- Dockerfile if appropriate
- docker-compose for local MongoDB/Redis if appropriate
- `.env.example`
- production config validation
- graceful shutdown
- request timeout handling
- rate limit review
- CORS review
- security headers review
- dependency vulnerability notes
- README production checklist

## Security Hardening Checklist

Confirm:

- no secrets committed
- CORS is strict in production
- JWT secrets are required in production
- refresh tokens are hashed
- body limits exist
- file limits exist
- rate limits protect sensitive endpoints
- validation exists for all public endpoints
- socket payload validation exists
- no raw Mongo queries use untrusted input
- no stack traces in production responses

## Deployment Checklist

Document:

- required environment variables
- MongoDB setup
- Redis setup
- storage provider setup
- health/readiness endpoints
- migration/index setup if applicable
- start command
- build command
- test command
- log destination
- backup expectations

## Testing Expectations

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

If scripts do not exist, add appropriate scripts or document what is missing.

Add tests for:

- global error handler
- auth security flows
- authorization checks
- validation middleware
- message membership checks
- disappearing message expiration and redaction
- story visibility and expiration
- upload restrictions
- socket authentication

## Done Criteria

- app can be built and started in production mode
- critical tests pass
- README and `.env.example` are current
- production security checklist is satisfied
- Claude reports any remaining risks clearly
