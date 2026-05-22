# Prompt 14: Devices And Push Notifications

You are an expert backend engineer building device registration and privacy-safe push notifications.

Inspect the current backend first. Follow existing queue, notification, auth, and validation patterns.

## Goal

Support device tokens, notification preferences, muted conversations, and push notification delivery without leaking private content.

## Required Features

- register device token
- update device metadata
- unregister device token
- list current user's devices
- notification preference management
- muted conversation support
- push notification job producer
- push notification worker placeholder or implementation
- cleanup stale device tokens

## Data Model Guidance

Device:

- userId
- platform: `ios`, `android`, `web`
- pushTokenHash or encrypted token
- pushTokenProvider
- deviceName
- appVersion
- lastSeenAt
- revokedAt
- createdAt

NotificationPreference:

- userId
- pushEnabled
- messagePreviewEnabled
- soundEnabled
- vibrationEnabled
- quietHours

ConversationNotificationPreference:

- userId
- conversationId
- mutedUntil
- mentionOnly

## Privacy Rules

- push payloads should contain minimal data
- do not include full message text unless `messagePreviewEnabled` is true
- never include sensitive report/moderation/private attachment contents in push payloads
- respect muted conversations
- respect blocks
- only notify conversation members
- remove invalid provider tokens

## API Routes

```txt
POST   /api/v1/devices
GET    /api/v1/devices
PATCH  /api/v1/devices/:deviceId
DELETE /api/v1/devices/:deviceId

GET    /api/v1/notification-preferences
PATCH  /api/v1/notification-preferences
PATCH  /api/v1/conversations/:conversationId/notification-preferences
```

## Queue Rules

- push jobs should include IDs, not huge private payloads
- workers should load fresh data before sending
- jobs must be retry-safe
- failures should be logged without leaking tokens or private content

## Testing

Add tests for:

- device registration
- user cannot access another user's device
- unregister device
- muted conversation suppresses push
- private preview setting changes payload shape
- stale/invalid token cleanup if implemented

## Done Criteria

- device APIs are user-scoped
- push payloads are privacy-safe
- notification preferences are enforced
- queue behavior is documented
