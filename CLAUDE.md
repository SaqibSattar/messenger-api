# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State: spec-only, no code yet

This repository contains **no application code** — there is no `package.json`, `src/`, or build tooling. It currently holds only specification documents. The messenger backend is meant to be built incrementally by working through those specs. The first implementation task (project scaffolding) is `messenger-nodejs-production-prompts/01-project-foundation.md`.

When asked to "run tests / lint / build" before any code exists, there is nothing to run yet — scaffold the foundation first (per prompt 01), which establishes the `package.json` scripts (`lint`, `typecheck`, `test` via Jest/Supertest) that all later work depends on.

## The two source-of-truth documents

- **`AGENTS.md`** — the canonical engineering spec. It defines the required stack, architecture, security requirements, API/response conventions, logging rules, and coding rules for the whole project. **Read it before implementing any feature.**
- **`messenger-nodejs-production-prompts/`** — a numbered prompt pack that breaks the build into one module per file. `00-prompt-order.md` defines the build sequence. Each numbered file (`01`…`18`) is a self-contained spec for one feature with its own "Done Criteria". `messenger-nodejs-production-prompt.md` is the overview (mirror of `AGENTS.md`).

Build **one module at a time, in the prompt-pack order** (foundation → auth → permissions → users → conversations → messages → realtime → media → … → hardening). Do not scaffold everything at once. Before each module: inspect the existing code and follow established patterns; after each: ensure lint/typecheck/tests pass and update `.env.example` / docs for any new env vars, routes, socket events, or models.

## Intended stack

Node.js + TypeScript (strict), Express or Fastify, MongoDB/Mongoose for chat data, Redis for presence/typing/rate-limiting/socket-session tracking and the Socket.IO scaling adapter, Socket.IO for realtime, JWT access tokens with rotating refresh tokens, argon2/bcrypt for passwords, Zod or Joi for validation, Helmet + strict CORS, Pino or Winston for structured logs, Jest + Supertest for tests. Do not add a major dependency without justifying it. Do not introduce PostgreSQL or mix datastores without a stated production reason.

## Architecture conventions

**Module-per-feature layout** under `src/modules/<feature>/`, each owning its own files:
```
<feature>.model.ts  .routes.ts  .controller.ts  .service.ts  .validation.ts  .test.ts
```
Plus top-level `src/{app.ts, server.ts, config/, db/, middleware/, sockets/, services/, utils/, validators/, types/, jobs/, tests/}`. `app.ts` (wiring) and `server.ts` (process/listen) stay separate.

**Layering is strict:**
- Controllers: read validated input, call a service, return the standard response shape. No business logic, no direct DB access.
- Services: own business logic, enforce ownership/permissions, call models, coordinate side effects (socket emits, notifications, jobs).
- Middleware: auth, authorization, validation, rate limiting, request IDs, error handling, upload limits.

**Authorization is two-layered — this is the most important architectural rule.** Route-level middleware (`requireAuth`, `requireRole`, `requirePermission`) is not sufficient. Every service must also do resource-level checks (conversation membership, ownership of message/attachment/report/notification) so a valid token can never reach another user's private data. Roles: `member`, `moderator`, `admin`, `super-admin`. Permissions are named like `conversation:read`, `message:moderate`, `report:review`, `admin:audit:read`.

## API & data conventions

- All routes are versioned under `/api/v1/...`.
- Success responses: `{ "success": true, "data": {...}, "message"?: "..." }`.
- Error responses: `{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [] } }` via centralized error handling. Never leak stack traces or internal details in production.
- Health: `GET /health` (process up) and `GET /ready` (verifies MongoDB + Redis).
- Config is centralized and **validated at startup — fail fast if required production secrets are missing**. Never hardcode secrets; no wildcard CORS in production.
- Message/story lists use **cursor-based pagination** with bounded page sizes — never load whole conversations.
- Never return raw DB documents; map to lean DTOs that exclude sensitive fields (passwordHash, token hashes, etc.).
- Never log passwords, raw refresh tokens, OTP/reset codes, auth headers, or private message bodies.

## Data model notes (see `12-data-model-indexes-migrations.md`)

Core collections: `users`, `sessions`, `conversations`, `conversation_members`, `messages`, `message_receipts`, `attachments`, `stories`, `story_views`, `story_mutes`, `blocks`, `reports`, `notifications`, `audit_logs`, `devices`. Refresh tokens are stored **hashed** in `sessions` and rotated on every refresh (reuse must be rejected). Enforce uniqueness invariants (one membership per user/conversation, one block per blocker/blocked pair, deduped direct conversations, one receipt per message/user) via unique indexes. Use TTL/cleanup for expiring messages, stories, and pending uploads. Migrations must be idempotent and non-destructive without explicit approval.
