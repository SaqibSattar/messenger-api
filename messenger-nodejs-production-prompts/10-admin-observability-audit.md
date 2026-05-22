# Prompt 10: Admin, Observability, And Audit

You are an expert production backend engineer.

Build admin-safe operational visibility, audit logging, metrics, and system observability for a messenger backend.

## Goal

Make the backend easier to operate in production without exposing private user data.

## Required Features

- audit log utility/service
- audit logs for sensitive actions
- admin-only audit log list endpoint
- structured request logging
- metrics endpoint if appropriate
- system health/readiness improvements
- admin dashboard summary endpoint if appropriate
- safe operational error metadata

## Audit Events

Audit:

- login failures where useful
- password changes
- session revocations
- profile changes
- group membership changes
- message moderation deletes
- reports and moderation actions
- attachment deletes
- admin role changes

Do not audit private message bodies unless legally required and explicitly approved.

## Data Model Guidance

AuditLog:

- actorId
- action
- targetType
- targetId
- ipAddress
- userAgent
- metadata sanitized
- createdAt

## Security Rules

- audit endpoints are admin-only
- logs must not contain passwords, tokens, reset codes, or raw private message bodies
- operational endpoints must not leak secrets
- metrics should not expose user personal data
- add pagination to audit log list

## API Routes

```txt
GET /api/v1/admin/audit-logs
GET /api/v1/admin/system-summary
GET /metrics
```

Only add `/metrics` if it fits the stack and deployment model.

## Logging Rules

Use structured logs with:

- request ID
- user ID when authenticated
- route
- status code
- latency
- safe error code

Never log:

- passwords
- access tokens
- refresh tokens
- reset codes
- full private message bodies
- private attachment contents

## Testing

Add tests for:

- audit log creation
- admin-only audit access
- pagination
- metadata sanitization
- health/readiness behavior

## Done Criteria

- sensitive actions create audit logs
- admin endpoints are protected
- logs and metrics are privacy-safe
- tests pass
