# Socket.IO API

The realtime layer rides on the same HTTP server as the REST API. Clients
should treat sockets as a delivery channel for events that already have a
REST equivalent — never as a substitute for REST writes that should be
durable. (Receipts are the one exception: `message.delivered` /
`message.read` over the socket call the same service the REST routes do.)

## Connection

- **URL:** same origin as the REST API.
- **Path:** value of `SOCKET_PATH` (default `/socket.io`).
- **Transport:** WebSocket preferred, with polling fallback.
- **Auth:** the access token must be passed at handshake time as either
  `auth: { token }` (preferred) or the `Authorization: Bearer ...` header.
  Tokens in query strings are **rejected** — they leak into proxy logs.

A handshake without a valid, active-user access token is rejected with the
`UNAUTHORIZED` code. The server never trusts a user identity carried in a
socket event payload.

### Example (socket.io-client)

```ts
import { io } from 'socket.io-client';

const socket = io('https://api.example.com', {
  path: '/socket.io',
  auth: { token: accessToken }
});

socket.on('connect_error', (err) => {
  // err.message will be 'UNAUTHORIZED' for auth failures.
});
```

## Rooms

Rooms are server-controlled. Clients never name a room directly.

| Room | Auto-joined | Used for |
| --- | --- | --- |
| `user:{userId}` | Yes, on connect | Per-user pushes (notifications, presence pings to your own devices). |
| `conversation:{conversationId}` | No — must call `conversation.join` | Per-conversation fan-out (messages, typing, presence to counterparts). |

Joining a `conversation:{id}` room requires an active membership in that
conversation. The check runs server-side every time you join — a token alone
is not enough.

## Ack shape

Every client→server event takes an optional ack callback. The server's
response is one of:

```json
{ "ok": true }
```

```json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "...", "details": null } }
```

Error codes are the same catalogue as REST — see
[ERROR_CODES.md](./ERROR_CODES.md). `details` is optional and only present
when the code is `VALIDATION_ERROR` (it carries a flattened Zod tree).

## Client → server events

| Event | Payload | Auth requirement | Notes |
| --- | --- | --- | --- |
| `conversation.join` | `{ conversationId: string }` | Active member of the conversation. | Joins `conversation:{id}`. Returns `FORBIDDEN` for non-members. |
| `conversation.leave` | `{ conversationId: string }` | Authenticated. | Leaves the room. Idempotent. |
| `typing.start` | `{ conversationId: string }` | Active member. | Broadcasts `typing.started` to other members. Rate-limited by `SOCKET_TYPING_MAX_PER_MINUTE` — excess returns `RATE_LIMITED`. |
| `typing.stop` | `{ conversationId: string }` | Active member. | Broadcasts `typing.stopped`. Rate-limited as above. |
| `message.delivered` | `{ messageId: string }` | Active member of the message's conversation, not the sender. | Calls the same `markDelivered` service the REST route uses. Acks carry the upstream error code if it fails. |
| `message.read` | `{ messageId: string }` | Active member of the message's conversation, not the sender. | Calls `markRead`. |
| `presence.ping` | `{}` | Authenticated. | Refreshes the user's presence TTL. Does **not** re-broadcast `presence.online`. |

Bad payloads (wrong fields, malformed ObjectId, unexpected keys) are
rejected with `VALIDATION_ERROR` before any DB call.

## Server → client events

All conversation events fan out to `conversation:{id}` so a non-member can
never receive them. Presence events fan out only to the conversation rooms
the moving user belongs to — users with no shared conversation cannot see
each other's presence.

| Event | Payload | Broadcast room | Source |
| --- | --- | --- | --- |
| `message.created` | `{ conversationId, message: MessageDto }` | `conversation:{id}` | `messages.sendMessage` |
| `message.updated` | `{ conversationId, message: MessageDto }` | `conversation:{id}` | `messages.editMessage` |
| `message.deleted` | `{ conversationId, message: MessageDto }` | `conversation:{id}` | `messages.deleteMessage` |
| `message.expired` | `{ conversationId, messageId, message: MessageDto }` | `conversation:{id}` | `messages.expireMessageNow`, cleanup job |
| `message.reaction_added` | `{ conversationId, messageId, reaction: MessageReactionDto }` | `conversation:{id}` | `messages.addReaction` |
| `message.reaction_removed` | `{ conversationId, messageId, reactionId, userId }` | `conversation:{id}` | `messages.removeReaction` |
| `message.delivered` | `{ conversationId, messageId, receipt: MessageReceiptDto }` | `conversation:{id}` | `messages.markDelivered` |
| `message.read` | `{ conversationId, messageId, receipt: MessageReceiptDto }` | `conversation:{id}` | `messages.markRead` |
| `conversation.disappearing_settings_updated` | `{ conversationId, disappearingMessages }` | `conversation:{id}` | `conversations.setDisappearingMessages` |
| `typing.started` | `{ conversationId, userId, at: ISO8601 }` | `conversation:{id}` (excluding sender) | `typing.start` |
| `typing.stopped` | `{ conversationId, userId, at: ISO8601 }` | `conversation:{id}` (excluding sender) | `typing.stop` |
| `presence.online` | `{ userId, at: ISO8601 }` | each `conversation:{id}` the user belongs to | First device connect |
| `presence.offline` | `{ userId, at: ISO8601 }` | each `conversation:{id}` the user belongs to | Last device disconnect |
| `story.created` | `{ story: StoryDto }` | `user:{viewerId}` for each visible viewer | `stories.createStory` |
| `story.deleted` | `{ storyId }` | `user:{viewerId}` | `stories.deleteStory` |
| `story.expired` | `{ storyId }` | `user:{viewerId}` | TTL cleanup job |
| `story.viewed` | `{ storyId, viewerId, viewedAt }` | `user:{authorId}` | `stories.recordView` |

DTOs (`MessageDto`, `MessageReceiptDto`, `MessageReactionDto`, `StoryDto`,
`DisappearingMessageSettings`) match the REST response bodies exactly — the
same DTO mappers run for both transports.

## Presence

Backed by Redis when `REDIS_URL` is configured, with an in-memory fallback
otherwise. Keys carry `PRESENCE_TTL_SECONDS` and are refreshed by
`presence.ping`. A crashed instance's state decays naturally — no manual
cleanup needed.

## Scaling

With `REDIS_URL` set, the Socket.IO Redis adapter is installed so emits
from one app instance reach sockets connected to another. Without Redis we
log a warning and run in single-instance mode (suitable for development
only).
