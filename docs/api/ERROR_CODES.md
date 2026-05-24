# Error codes

Every error response — REST or socket — carries a stable string `code`. The
HTTP status (or socket ack) tells a client *what kind* of failure happened;
the `code` tells them *which one* of that kind, so they can branch in code
without parsing free-text `message` strings.

**Renaming or removing a code is a breaking change.** See
[VERSIONING.md](./VERSIONING.md) for the deprecation rules.

Source of truth: [`src/utils/errorCodes.ts`](../../src/utils/errorCodes.ts).

## Catalogue

| Code | HTTP status | When | `details`? |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Request body / query / params / socket payload failed Zod validation. | Flattened Zod tree: `{ formErrors, fieldErrors }`. |
| `BAD_REQUEST` | 400 | Generic 4xx the request shape was valid but the value is rejected (e.g. self-block). | Optional. |
| `INVALID_JSON` | 400 | Body was not parseable JSON. | None. |
| `UNAUTHORIZED` | 401 | Missing or invalid access token, or token issued before a password change. | None. |
| `FORBIDDEN` | 403 | Authenticated, but the actor lacks the required permission for this resource. | None. |
| `NOT_FOUND` | 404 | Resource does not exist, or exists but is hidden from the caller for privacy (non-membership). | None. |
| `CONFLICT` | 409 | Uniqueness or state conflict (duplicate registration, duplicate direct-conversation pair, duplicate block, etc.). | None. |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeded `BODY_LIMIT`. | None. |
| `RATE_LIMITED` | 429 | Per-route or per-socket rate limit tripped. `Retry-After` header is set. | None. |
| `INTERNAL_ERROR` | 500 | Unhandled server error. In production the `message` is generic; the request ID in `X-Request-Id` is the way to find the stack. | None. |
| `INTERNAL` | socket-only | A socket handler failed in a way that does not map to an HTTP status. | None. |

## Why some 4xx codes share a status

- `VALIDATION_ERROR`, `BAD_REQUEST`, and `INVALID_JSON` all return 400 but
  describe different failure modes. A client that only inspects status would
  retry indistinguishably; branching on `code` lets a client surface a
  field-level form error for `VALIDATION_ERROR`, a generic toast for
  `BAD_REQUEST`, and a hard "the request is corrupt — do not retry" for
  `INVALID_JSON`.

- `UNAUTHORIZED` (401) covers both "no token" and "token rejected". The
  client's response is the same: refresh or re-login. The server intentionally
  does **not** distinguish "token expired" from "token revoked" in the public
  code, because doing so would leak whether a token had been explicitly
  revoked (an account-takeover signal).

## Privacy-driven choices

- A non-member who probes a private conversation gets `404 NOT_FOUND`, not
  `403 FORBIDDEN`. This prevents enumerating the existence of conversations
  the caller has no business knowing about.

- Login failures use a generic `UNAUTHORIZED` message — never "user not
  found" vs "wrong password" — to prevent user enumeration.

- Duplicate registration returns `409 CONFLICT` without saying whether the
  email or phone was taken, for the same reason.

## What clients should do

- **Branch on `error.code`, not on `error.message`.** Messages are
  human-readable and may change at any time. Codes are part of the contract.
- **Show `error.message` to end users only when no friendlier mapping
  exists.** Codes like `VALIDATION_ERROR` carry per-field detail in
  `details.fieldErrors` — surface those next to the right form field instead.
- **Respect `Retry-After` on 429.** Do not retry sooner; the limit will
  reject you again.
- **Capture `X-Request-Id`.** Include it in bug reports — it is the only
  way to find the matching server log line.

## Adding a new error code

1. Add the constant to `src/utils/errorCodes.ts` with a comment explaining
   when it's raised.
2. Update this table.
3. Use it via the `ERROR_CODES` constant — never hardcode the string at the
   call site. The contract-shape test (`src/tests/contracts.test.ts`) catches
   responses that use unknown codes.
