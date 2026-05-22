# Prompt 06: Realtime Sockets And Presence

You are an expert realtime backend engineer.

Build or improve realtime sockets, authenticated socket connections, conversation rooms, typing indicators, online presence, and delivery/read events.

## Goal

Create production-safe realtime behavior that works with multiple server instances.

## Required Features

- socket server setup
- access token authentication during connection
- attach authenticated user to socket context
- Redis adapter for horizontal scaling if Socket.IO is used
- join/leave conversation rooms with membership checks
- user-specific rooms
- typing start/stop
- online/offline presence
- message delivery event support
- read receipt event support
- disconnect cleanup

## Security Rules

- never trust user ID from socket payload
- validate every socket event payload
- check conversation membership before joining a room
- check conversation membership before sending typing/read events
- do not broadcast private data globally
- rate limit noisy events such as typing
- handle expired/invalid tokens by rejecting the connection

## Room Naming

Use server-generated room names:

```txt
user:{userId}
conversation:{conversationId}
```

Never let clients choose arbitrary room names.

## Events

Client to server:

```txt
conversation.join
conversation.leave
typing.start
typing.stop
message.delivered
message.read
presence.ping
```

Server to client:

```txt
message.created
message.updated
message.deleted
message.reaction_added
message.reaction_removed
typing.started
typing.stopped
presence.online
presence.offline
message.delivered
message.read
```

## Redis Presence

Use Redis for:

- user online status
- active socket IDs
- last seen timestamps
- multi-instance presence state

Use TTLs so stale presence eventually expires.

## Testing

Add tests where practical for:

- invalid token rejected
- valid token accepted
- non-member cannot join conversation room
- typing event requires membership
- disconnect cleanup
- event payload validation

## Done Criteria

- socket auth is enforced
- membership checks protect rooms/events
- Redis adapter/presence is production-ready
- events are documented
