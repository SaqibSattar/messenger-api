# Versioning and deprecation

## Versioning scheme

All public API routes live under a major-version prefix:

```
/api/v1/...
```

Socket events do **not** carry an explicit version; they version implicitly
with the REST major version because the same client uses both transports.

There is exactly one supported major version at any time during normal
operation. A new major version is only introduced when a change cannot be
expressed compatibly under the existing one (see "Breaking changes" below).

## What counts as a breaking change

The following are **breaking** and require a major-version bump (`/api/v2`):

- Removing or renaming a route, route segment, or path parameter.
- Removing or renaming a field in a response body.
- Changing the type of an existing field (e.g. string → object).
- Changing the semantics of an existing field (e.g. switching a timestamp
  from local time to UTC).
- Removing or renaming an `error.code` value, or changing its HTTP status.
- Removing or renaming a socket event, or removing a payload field.
- Tightening validation in a way that rejects previously-accepted requests.
- Making a previously-optional request field required.
- Making a previously-required response field optional (clients may have
  been relying on it).

The following are **non-breaking** and ship inside the current major
version:

- Adding a new route, query parameter, or optional request field.
- Adding a new field to a response body (clients are expected to ignore
  unknown fields).
- Adding a new socket event or a new optional payload field on an existing
  event.
- Adding a new `error.code` value, provided the HTTP status it returns
  under was already documented for that route.
- Loosening validation (accepting more input than before).
- Improving wording of `error.message` — messages are human-readable and
  not part of the contract.

## Deprecation policy

When a field, parameter, or route is on its way out under the same major
version, mark it deprecated rather than removing it.

1. **Document.** Add a `> **Deprecated** — ...` callout to the relevant
   table in [REST.md](./REST.md) / [SOCKETS.md](./SOCKETS.md) / [ERROR_CODES.md](./ERROR_CODES.md). State the replacement and the
   target removal date.
2. **Header.** Responses from a deprecated route SHOULD include
   `Deprecation: true` and `Sunset: <RFC 7231 date>` (per IETF
   `draft-ietf-httpapi-deprecation-header`). A `Link: <...>; rel="successor-version"`
   header pointing at the replacement is recommended.
3. **Minimum window.** Keep a deprecated route or field live for **at
   least 90 days** after the first release containing the deprecation, so
   that mobile-app users on slow upgrade cycles have time to move.
4. **Removal.** Removal of a deprecated route or field requires a major
   version bump *unless* it was marked deprecated before any production
   client depended on it (i.e. during early development).

## Major-version transitions

When a new major version is necessary:

- `/api/v2` is added alongside `/api/v1`. Both run from the same process.
- Each `v1` route that maps to a `v2` route returns the deprecation headers
  described above with a `Sunset:` at least 180 days out.
- `v1` is removed only after the sunset date and after telemetry shows
  active-client traffic has dropped to noise.
- Socket events keep working under the old contract as long as `v1` does.
  Clients that opt in by passing `auth: { token, apiVersion: 2 }` at
  handshake time get the new event shapes; legacy clients continue to
  receive `v1` shapes.

## Out-of-band changes

Some changes are not part of the versioned contract and may happen at any
time without a major bump:

- Rate-limit thresholds. Clients must already handle `429 RATE_LIMITED`.
- Latency, internal request routing, or which Mongo / Redis instance backs
  a request.
- Operational endpoints (`/health`, `/ready`, `/metrics`) — these are not
  part of the client API.
- Internal database schema, indexes, and migration order — observable only
  via behaviour, not via response shape.

## How a client picks the right version

- **Always set the version in the URL** (`/api/v1/...`). Do not rely on a
  default version header.
- **Pin to one version per release of your client.** Do not mix `v1` and
  `v2` calls in the same session.
- **Read the deprecation headers on every response in CI.** A new
  deprecation appearing in your test suite is your earliest warning that
  an upgrade is needed.
