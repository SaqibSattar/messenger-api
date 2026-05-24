# REST API

Base URL: `https://<host>/api/v1`

All endpoints below speak JSON and follow the shapes documented in
[README.md](./README.md). For the error-code catalogue see
[ERROR_CODES.md](./ERROR_CODES.md).

## Operational endpoints (unversioned)

These live outside `/api/v1` because they are operator-facing, not part of the
client API.

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| `GET` | `/health` | Process is up. | None |
| `GET` | `/ready` | Process up **and** Mongo + Redis reachable. `200` when ready, `503` otherwise. | None |
| `GET` | `/metrics` | Process and collection counters (privacy-safe). | `requireAuth` + `admin:system:read` |

---

## Auth (`/api/v1/auth`)

| Method | Path | Purpose | Auth | Rate limit |
| --- | --- | --- | --- | --- |
| `POST` | `/register` | Create an account by email or phone. | Public | 10 / hour |
| `POST` | `/login` | Exchange credentials for access + refresh tokens. | Public | 20 / 15 min |
| `POST` | `/refresh` | Rotate refresh token, get a fresh access token. | Public (refresh token in body) | 60 / 15 min |
| `POST` | `/logout` | Revoke the supplied refresh token. | Public | — |
| `POST` | `/logout-all` | Revoke every session for the current user. | Bearer | — |
| `POST` | `/change-password` | Change password; revokes other sessions. | Bearer | — |
| `POST` | `/forgot-password` | Trigger a password reset (no-op response always). | Public | 5 / hour |
| `POST` | `/reset-password` | Consume a reset token. | Public | 10 / hour |
| `GET`  | `/me` | Current user profile from access token. | Bearer | — |

### Example — login

Request:

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "alice@example.com", "password": "<plain text>" }
```

Response (`200`):

```json
{
  "success": true,
  "data": {
    "user": { "id": "65f...", "email": "alice@example.com", "displayName": "Alice", "role": "member" },
    "tokens": {
      "accessToken": "<jwt>",
      "accessTokenExpiresIn": 900,
      "refreshToken": "<opaque>",
      "refreshTokenExpiresIn": 1209600
    }
  }
}
```

Failure (`401`):

```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "Invalid credentials" } }
```

Login and registration intentionally **never reveal which identifier was
taken** — a duplicate-registration attempt returns `409 CONFLICT` with a
generic message.

---

## Users (`/api/v1/users`)

| Method | Path | Purpose | Auth | Rate limit |
| --- | --- | --- | --- | --- |
| `GET`   | `/me` | Current user profile. | Bearer | — |
| `PATCH` | `/me` | Update display name / bio / avatar. | Bearer | — |
| `POST`  | `/me/deactivate` | Soft-deactivate the account; revokes sessions. | Bearer | 5 / hour |
| `POST`  | `/me/delete-request` | Schedule account deletion (30-day grace). Password-confirmed. Revokes sessions and devices. | Bearer | 5 / hour |
| `POST`  | `/me/delete-cancel` | Cancel a pending deletion. | Bearer | 10 / hour |
| `GET`   | `/me/data-export` | JSON export of the caller's data. Excludes secrets/tokens. | Bearer | 3 / hour |
| `GET`   | `/search?q=...&limit=...` | Find users by display name / username. Respects `whoCanFindMe`. | Bearer | 30 / 60 s |
| `GET`   | `/:userId/public` | Public profile fields only. Respects `profilePhotoVisibility`. | Bearer | — |

See [PRIVACY_RETENTION.md](../PRIVACY_RETENTION.md) for the full lifecycle
state machine (active → pending_deletion → deleted), what finalization
preserves vs deletes, and retention windows for sessions, notifications,
invites, and reports.

### Example — delete-request

```http
POST /api/v1/users/me/delete-request
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "password": "<current password>" }
```

Response (`200`):

```json
{
  "success": true,
  "data": {
    "user": { "id": "65f...", "status": "pending_deletion", "deletionScheduledFor": "2026-06-23T10:15:30.000Z" },
    "deletion": {
      "deletionRequested": true,
      "requestedAt": "2026-05-24T10:15:30.000Z",
      "scheduledFor": "2026-06-23T10:15:30.000Z",
      "graceDaysRemaining": 30,
      "state": "pending"
    }
  }
}
```

The request immediately revokes every active session (existing refresh
tokens stop working) and every push device. The user can still sign back in
to reach `/me/delete-cancel` or `/me/data-export` during the grace window.

---

## Conversations (`/api/v1/conversations`)

| Method | Path | Purpose | Permission | Rate limit |
| --- | --- | --- | --- | --- |
| `POST`   | `/direct` | Create or fetch the direct conversation with a peer. | `conversation:create` | 60 / hour |
| `POST`   | `/groups` | Create a group conversation. | `conversation:create` | 30 / hour |
| `GET`    | `/` | List my conversations (cursor-paginated). | `conversation:read` | — |
| `GET`    | `/:conversationId` | Fetch one conversation I belong to. | `conversation:read` | — |
| `PATCH`  | `/:conversationId` | Update group title / topic / avatar. | `conversation:manage_settings` | — |
| `POST`   | `/:conversationId/members` | Add members. | `conversation:manage_members` | — |
| `DELETE` | `/:conversationId/members/:userId` | Remove a member. | `conversation:manage_members` | — |
| `PATCH`  | `/:conversationId/members/:userId/role` | Change a member's role. | `conversation:manage_members` | — |
| `POST`   | `/:conversationId/leave` | Leave a group. | member | — |
| `PATCH`  | `/:conversationId/read` | Move my last-read pointer. | member | — |
| `PATCH`  | `/:conversationId/preferences` | Update mute / archive / pinned. | member | — |
| `PATCH`  | `/:conversationId/disappearing-messages` | Update disappearing-message settings. | `message:disappearing:manage_group` | 30 / 60 s |

A non-member who probes a conversation gets `404 NOT_FOUND` — never `403` —
so the existence of private conversations is not enumerable.

---

## Messages

Scoped under `/api/v1/conversations/:conversationId/messages` for collection
operations and under `/api/v1/messages/:messageId` for item operations.

| Method | Path | Purpose | Permission | Rate limit |
| --- | --- | --- | --- | --- |
| `POST`   | `/conversations/:conversationId/messages` | Send a message. | `message:create` + active membership | 120 / 60 s |
| `GET`    | `/conversations/:conversationId/messages?cursor=...&limit=...` | List messages (cursor-paginated, newest-first). | `conversation:read` + active membership | — |
| `GET`    | `/messages/:messageId` | Fetch one message. | `conversation:read` + active membership | — |
| `PATCH`  | `/messages/:messageId` | Edit own message. | `message:edit_own` (or `message:moderate`) | — |
| `DELETE` | `/messages/:messageId` | Delete own message. | `message:delete_own` (or `message:moderate`) | — |
| `POST`   | `/messages/:messageId/reactions` | Add a reaction. | member | 180 / 60 s |
| `DELETE` | `/messages/:messageId/reactions/:reactionId` | Remove own reaction. | reaction owner | — |
| `POST`   | `/messages/:messageId/delivered` | Mark delivered. | member, not sender | — |
| `POST`   | `/messages/:messageId/read` | Mark read. | member, not sender | — |
| `POST`   | `/messages/:messageId/expire-now` | Force-expire a disappearing message. | `message:disappearing:manage_own` | 30 / 60 s |

### Example — list messages

Request:

```http
GET /api/v1/conversations/65f.../messages?limit=30
Authorization: Bearer <access token>
```

Response (`200`):

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "65f0a1...",
        "conversationId": "65f...",
        "senderId": "65f...",
        "text": "Hello",
        "attachments": [],
        "createdAt": "2026-05-24T10:15:30.123Z",
        "updatedAt": "2026-05-24T10:15:30.123Z"
      }
    ],
    "nextCursor": "65f0a1..."
  }
}
```

When `nextCursor` is `null` the caller has reached the oldest available
message.

### Example — send message

Request:

```http
POST /api/v1/conversations/65f.../messages
Authorization: Bearer <access token>
Content-Type: application/json

{ "text": "hi", "replyToMessageId": "65f...", "attachmentIds": ["65f..."] }
```

Response (`201`):

```json
{ "success": true, "data": { "message": { "id": "65f...", "...": "..." } } }
```

### Disappearing messages

Conversation-wide setting via `PATCH /conversations/:id/disappearing-messages`
takes `{ enabled, ttlSeconds, policy: "send_time" }`. A new message inherits
the conversation's current TTL at send time. Force-expire is only allowed for
your own messages; clients should not assume a particular delete order.

---

## Media (`/api/v1/media`) <a name="media"></a>

| Method | Path | Purpose | Permission | Rate limit |
| --- | --- | --- | --- | --- |
| `POST`   | `/upload-url` | Request a signed upload URL and an attachment id. | `media:create` | 60 / 60 s |
| `POST`   | `/complete` | Finalize an upload after the bytes have been `PUT` to storage. | `media:create` | 120 / 60 s |
| `GET`    | `/:attachmentId` | Get a short-lived signed download URL. | `media:read` + access to a conversation that contains the attachment | — |
| `DELETE` | `/:attachmentId` | Delete an attachment you own. | `media:delete_own` | — |

The two-step upload (`upload-url` → `PUT` directly to storage → `complete`)
keeps large files off the API server. Filenames are server-generated; the
client's `originalFilename` is metadata only and is never used as a storage
key.

---

## Stories (`/api/v1/stories`)

| Method | Path | Purpose | Permission | Rate limit |
| --- | --- | --- | --- | --- |
| `POST`   | `/` | Post a story. | `story:create` | 60 / hour |
| `GET`    | `/` | List visible stories. | `story:read` | — |
| `POST`   | `/mutes` | Mute an author. | `story:read` | 60 / 60 s |
| `DELETE` | `/mutes/:userId` | Unmute an author. | `story:read` | — |
| `GET`    | `/:storyId` | Fetch one story. | `story:read` | — |
| `POST`   | `/:storyId/view` | Record that I viewed a story. | `story:read` | 180 / 60 s |
| `GET`    | `/:storyId/viewers` | List viewers (author only). | author | — |
| `DELETE` | `/:storyId` | Delete own story. | `story:delete_own` (or `story:moderate`) | — |
| `POST`   | `/:storyId/report` | Report a story for moderation. | `report:create` | 20 / hour |

---

## Contacts (`/api/v1/contacts`)

| Method | Path | Purpose | Permission | Rate limit |
| --- | --- | --- | --- | --- |
| `POST`   | `/requests` | Send a contact request. | `contact:create` | 30 / hour |
| `GET`    | `/requests/incoming` | List incoming requests. | `contact:read` | — |
| `GET`    | `/requests/outgoing` | List outgoing requests. | `contact:read` | — |
| `POST`   | `/requests/:requestId/accept` | Accept. | `contact:manage_own` | — |
| `POST`   | `/requests/:requestId/decline` | Decline. | `contact:manage_own` | — |
| `DELETE` | `/requests/:requestId` | Cancel outgoing. | `contact:manage_own` | — |
| `GET`    | `/` | List accepted contacts. | `contact:read` | — |
| `DELETE` | `/:userId` | Remove an accepted contact. | `contact:manage_own` | — |

---

## Invites

| Method | Path | Purpose | Permission | Rate limit |
| --- | --- | --- | --- | --- |
| `POST`   | `/conversations/:conversationId/invites` | Create a join link. | `invite:create` | 60 / hour |
| `GET`    | `/conversations/:conversationId/invites` | List active links for a conversation. | `invite:create` | — |
| `POST`   | `/invites/:token/join` | Join via invite token. | `invite:redeem` | 30 / 5 min |
| `DELETE` | `/invites/:inviteId` | Revoke a link. | `invite:create` | — |

Invite tokens are stored **hashed**; only the original token works to redeem,
and a revoked link returns `404 NOT_FOUND` (not `403`) to avoid leaking that
the link ever existed.

---

## Notifications

In-app notifications:

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| `GET`   | `/api/v1/notifications` | List my notifications. | `notification:read_own` |
| `PATCH` | `/api/v1/notifications/:id/read` | Mark one read. | `notification:read_own` |
| `PATCH` | `/api/v1/notifications/:id/unread` | Mark one unread. | `notification:read_own` |
| `POST`  | `/api/v1/notifications/read-all` | Bulk mark read (`30 / 60 s`). | `notification:read_own` |

Global preferences:

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| `GET`   | `/api/v1/notification-preferences` | Read my global push/email/in-app preferences. | `notification:manage_own` |
| `PATCH` | `/api/v1/notification-preferences` | Update preferences (`60 / 60 s`). | `notification:manage_own` |

Per-conversation overrides:

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| `GET`   | `/api/v1/conversations/:conversationId/notification-preferences` | Read per-conversation override. | `notification:manage_own` |
| `PATCH` | `/api/v1/conversations/:conversationId/notification-preferences` | Update override (`60 / 60 s`). | `notification:manage_own` |

---

## Devices (`/api/v1/devices`)

| Method | Path | Purpose | Permission | Rate limit |
| --- | --- | --- | --- | --- |
| `POST`   | `/` | Register a push device/token. | `device:manage_own` | 30 / hour |
| `GET`    | `/` | List my devices. | `device:manage_own` | — |
| `PATCH`  | `/:deviceId` | Update label / mute state. | `device:manage_own` | 60 / hour |
| `DELETE` | `/:deviceId` | Remove a device. | `device:manage_own` | — |

Push tokens are stored as hashes; clients must re-register on rotation.

---

## Blocks, reports, moderation

Blocks (`/api/v1/blocks`):

| Method | Path | Purpose | Rate limit |
| --- | --- | --- | --- |
| `POST`   | `/` | Block a user. | 60 / hour |
| `GET`    | `/` | List users I have blocked. | — |
| `DELETE` | `/:blockedUserId` | Unblock. | — |

Reports (`/api/v1/reports`):

| Method | Path | Purpose | Permission | Rate limit |
| --- | --- | --- | --- | --- |
| `POST`  | `/` | Report a user / message / story. | `report:create` | 20 / hour |
| `GET`   | `/` | List reports (own, unless `report:review`). | `report:create` | — |
| `GET`   | `/:reportId` | Fetch one report. | author or `report:review` | — |
| `PATCH` | `/:reportId/status` | Approve / reject / dismiss. | `report:review` | — |

Moderation actions (`/api/v1/moderation`):

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| `POST` | `/actions` | Apply an action (warn / delete / suspend). | `moderation:action` |
| `GET`  | `/actions` | List moderation actions. | `moderation:action` |

---

## Search (`/api/v1/search`)

| Method | Path | Purpose | Permission | Rate limit |
| --- | --- | --- | --- | --- |
| `GET` | `/conversations?q=&cursor=&limit=` | Search my conversations. | `conversation:read` | 60 / 60 s |
| `GET` | `/messages?q=&cursor=&limit=` | Search my message history. | `conversation:read` | 60 / 60 s |
| `GET` | `/users?q=&limit=` | Search users. Respects `whoCanFindMe`. | Bearer | 60 / 60 s |

All search endpoints enforce a minimum query length (configurable in the
search validator) to avoid full-collection scans.

---

## Privacy (`/api/v1/privacy-settings`)

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| `GET`   | `/` | Read my privacy settings. | `privacy:manage_own` |
| `PATCH` | `/` | Update (`whoCanFindMe`, `whoCanMessageMe`, `profilePhotoVisibility`, etc.). | `privacy:manage_own` |

---

## Admin (`/api/v1/admin`)

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| `PATCH` | `/users/:userId/role` | Promote / demote. | `admin:users:manage` |
| `PATCH` | `/users/:userId/permissions` | Adjust custom permissions. | `admin:users:manage` |
| `GET`   | `/audit-logs?cursor=&limit=` | Browse the audit log (cursor-paginated). | `admin:audit:read` |
| `GET`   | `/system-summary` | Privacy-safe collection counters and system stats. | `admin:system:read` |

---

## Common request validation rules

- Body, query, and path inputs are validated with Zod. Failures return
  `400 VALIDATION_ERROR` with a flattened error tree in `details`.
- Unknown fields in request bodies are ignored, not echoed. Do not rely on
  them passing through.
- ObjectId path params must be 24 hex chars or you get `400 VALIDATION_ERROR`.
- Pagination params: `limit` is clamped per-endpoint (see the audit summary
  in each service). `cursor` is opaque — pass back exactly what the previous
  page returned.

## Common response headers

| Header | Meaning |
| --- | --- |
| `X-Request-Id` | Stable identifier for this request; appears in logs. |
| `RateLimit-*` (draft-7) | Standard rate-limit headers on rate-limited routes. |
| `Retry-After` | On `429 RATE_LIMITED`, seconds to wait. |
