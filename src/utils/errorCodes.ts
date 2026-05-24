// Stable, public-facing error codes used in REST error responses
// (`{ error: { code, ... } }`) and in socket acks (`{ ok: false, error: ... }`).
//
// These codes are part of the API contract: renaming or removing one is a
// breaking change for clients. See docs/api/ERROR_CODES.md for the catalogue,
// HTTP status mapping, and deprecation policy.
//
// All places in the codebase that produce an error code MUST import from this
// file rather than hardcoding a string, so the catalogue stays the single
// source of truth.

export const ERROR_CODES = {
  // 400 — request shape / payload problems
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_JSON: 'INVALID_JSON',

  // 401 — authentication failures
  UNAUTHORIZED: 'UNAUTHORIZED',

  // 403 — authorization failures
  FORBIDDEN: 'FORBIDDEN',

  // 404 — resource not found / hidden behind 404 for privacy
  NOT_FOUND: 'NOT_FOUND',

  // 409 — state/uniqueness conflicts
  CONFLICT: 'CONFLICT',

  // 413 — request body exceeds limit
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  // 429 — rate limiting
  RATE_LIMITED: 'RATE_LIMITED',

  // 5xx — server-side problems
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Socket-only: the request was understood but the handler failed in a way
  // that does not map to a HTTP status. Distinct from INTERNAL_ERROR so
  // clients can tell HTTP and socket failures apart in shared logging.
  INTERNAL: 'INTERNAL'
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
