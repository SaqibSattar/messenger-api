# API contracts

This directory is the public contract for clients integrating with the
messenger backend. Anything in here is part of the API surface — change it
only under the rules in [VERSIONING.md](./VERSIONING.md).

| File | What it covers |
| --- | --- |
| [REST.md](./REST.md) | All REST endpoints under `/api/v1`, with request/response shape, auth, rate limits, and examples. |
| [SOCKETS.md](./SOCKETS.md) | Socket.IO connection, rooms, client→server events, server→client events, and ack shape. |
| [ERROR_CODES.md](./ERROR_CODES.md) | The catalogue of stable error codes returned in both REST and socket responses. |
| [VERSIONING.md](./VERSIONING.md) | Versioning policy, what counts as a breaking change, and the deprecation process. |

## Conventions used everywhere

- **Base URL:** `https://<host>/api/v1`. There is no unversioned route.
- **Authentication:** `Authorization: Bearer <accessToken>` on every
  authenticated route. Tokens are short-lived JWTs; refresh via
  `POST /auth/refresh`.
- **Content type:** `application/json` for requests and responses. The only
  exception is the signed-URL media upload, which is `PUT` directly to the
  storage provider with the bytes — see [REST.md](./REST.md#media).
- **Request ID:** every response carries an `X-Request-Id` header. Echo it
  back when reporting issues.
- **Timestamps:** ISO 8601 UTC strings (`2026-05-24T10:15:30.123Z`).
- **IDs:** MongoDB ObjectId strings (24 hex characters). Treat them as
  opaque on the client.
- **Success shape:**
  ```json
  { "success": true, "data": {...}, "message": "optional" }
  ```
- **Error shape:**
  ```json
  { "success": false, "error": { "code": "...", "message": "...", "details": [] } }
  ```
  `details` is optional and only present for `VALIDATION_ERROR` or other
  codes that need structured context. See [ERROR_CODES.md](./ERROR_CODES.md).
- **Pagination:** cursor-based, with the shape:
  ```json
  { "items": [...], "nextCursor": "<opaque-string>" | null }
  ```
  `nextCursor === null` means the caller has reached the end of the list.
  Cursors are server-defined and **opaque** — do not parse them client-side.

The internal source of truth for these shapes is:

- [`src/utils/apiResponse.ts`](../../src/utils/apiResponse.ts) — `ok()` / `created()` / `fail()` helpers.
- [`src/utils/errorCodes.ts`](../../src/utils/errorCodes.ts) — catalogue of error code constants.
- [`src/utils/pagination.ts`](../../src/utils/pagination.ts) — `PaginatedResult<T>` type and helper.
- [`src/middleware/errorHandler.ts`](../../src/middleware/errorHandler.ts) — central error → response mapper.
