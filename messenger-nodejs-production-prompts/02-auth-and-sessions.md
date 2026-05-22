# Prompt 02: Authentication And Sessions

You are an expert backend security engineer.

Build or improve the authentication and session module for a production-grade messenger backend. Inspect the current code first and follow existing patterns.

## Goal

Implement secure user authentication with access tokens, refresh token rotation, password hashing, safe logout, and account protection.

## Module Scope

Recommended files:

```txt
src/modules/auth/
  auth.routes.ts
  auth.controller.ts
  auth.service.ts
  auth.validation.ts
  auth.types.ts

src/modules/users/
  user.model.ts

src/modules/sessions/
  session.model.ts
```

## Required Features

- register
- login
- refresh access token
- logout current session
- logout all sessions
- password change
- password reset request placeholder or implementation
- current user endpoint support
- session persistence with hashed refresh tokens

## Security Requirements

- hash passwords with argon2 or bcrypt
- never store plain text passwords
- never store raw refresh tokens
- rotate refresh tokens on every refresh
- invalidate refresh token reuse
- revoke sessions after password change
- use short-lived access tokens
- rate limit login, register, refresh, and reset endpoints
- prevent user enumeration
- validate JWT issuer/audience when configured
- never log passwords, tokens, reset codes, or auth headers

## Data Model Guidance

User:

- email or phone
- passwordHash
- displayName
- avatarUrl
- status
- emailVerifiedAt or phoneVerifiedAt
- lastLoginAt
- createdAt
- updatedAt

Session:

- userId
- refreshTokenHash
- userAgent
- ipAddress
- expiresAt
- revokedAt
- createdAt
- rotatedAt

## API Routes

```txt
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
POST /api/v1/auth/logout-all
POST /api/v1/auth/change-password
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
GET  /api/v1/auth/me
```

## Validation

Validate:

- email format
- phone format if supported
- password length and strength
- display name length
- token presence
- password reset fields

Normalize email before storage and lookup.

## Testing

Add tests for:

- successful register/login
- invalid credentials
- duplicate register
- refresh token rotation
- refresh token reuse rejection
- logout
- logout all
- password change invalidates sessions
- validation errors
- rate limit behavior if practical

## Done Criteria

- no sensitive fields are returned
- auth endpoints are documented
- tokens and sessions behave safely
- tests and typecheck pass
