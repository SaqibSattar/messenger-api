# Sockets

Realtime layer for the messenger backend, built on Socket.IO. Lives behind the
same HTTP server as the REST API.

## Connection

- **Path:** `SOCKET_PATH` (default `/socket.io`).
- **Auth:** the client must pass the user's access token at handshake time,
  either as `auth: { token }` (preferred) or `Authorization: Bearer ...`.
  Tokens in query strings are rejected because they leak into proxy logs.
- A connection without a valid, active-user token is rejected with
  `UNAUTHORIZED`. No user identity is ever read from the socket payload.

## Rooms

Server-controlled only — clients never name rooms.

- `user:{userId}` — every authenticated socket joins this on connect. Used
  for user-targeted server pushes.
- `conversation:{conversationId}` — joined only after a successful
  `conversation.join`, which checks the user has an active membership.

## Ack shape

Every client→server event takes an optional ack callback. The server replies
with one of:

```json
{ "ok": true }
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "..." } }
```

## Client → server events

| Event | Payload | Auth | Notes |
|---|---|---|---|
| `conversation.join` | `{ conversationId }` | active member of conversation | Joins `conversation:{id}` |
| `conversation.leave` | `{ conversationId }` | authenticated | Leaves the room |
| `typing.start` | `{ conversationId }` | active member | Broadcasts `typing.started` to other members; rate-limited (`SOCKET_TYPING_MAX_PER_MINUTE`) |
| `typing.stop` | `{ conversationId }` | active member | Broadcasts `typing.stopped`; rate-limited |
| `message.delivered` | `{ messageId }` | active member of message's conversation, not the sender | Calls `markDelivered` service |
| `message.read` | `{ messageId }` | active member of message's conversation, not the sender | Calls `markRead` service |
| `presence.ping` | `{}` | authenticated | Refreshes presence TTL |

Bad payloads (wrong fields, malformed ObjectIds, unexpected keys) are rejected
with `VALIDATION_ERROR` before any DB call.

## Server → client events

All fan out to `conversation:{id}` so a non-member can never receive them.

| Event | Source |
|---|---|
| `message.created` | `messages.sendMessage` |
| `message.updated` | `messages.editMessage` |
| `message.deleted` | `messages.deleteMessage` |
| `message.expired` | `messages.expireMessageNow`, cleanup job |
| `message.reaction_added` | `messages.addReaction` |
| `message.reaction_removed` | `messages.removeReaction` |
| `message.delivered` | `messages.markDelivered` |
| `message.read` | `messages.markRead` |
| `conversation.disappearing_settings_updated` | `conversations.setDisappearingMessages` |
| `typing.started` / `typing.stopped` | `typing.*` socket events |
| `presence.online` / `presence.offline` | First/last device connect/disconnect, fanned out only to conversation rooms the user belongs to |

## Presence

Backed by Redis when available, in-memory fallback otherwise. Keys
(`presence:user:{id}:sockets`, `presence:user:{id}:lastSeen`) all carry a TTL
of `PRESENCE_TTL_SECONDS`, refreshed by `presence.ping`. A crashed instance's
state decays naturally — no manual cleanup needed.

Privacy: presence events are sent only to `conversation:{id}` rooms the user
is a member of. Users with no shared conversations are invisible.

## Scaling

When `REDIS_URL` is set, the Socket.IO Redis adapter is installed so emits
from one instance reach sockets connected to another. Without Redis we run in
single-instance mode (logged as a warning).
