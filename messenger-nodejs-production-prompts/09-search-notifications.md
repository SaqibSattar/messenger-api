# Prompt 09: Search And Notifications

You are an expert backend engineer building search and notification features for a messenger app.

Inspect existing code first and follow local patterns.

## Goal

Add safe search and notification infrastructure without leaking private conversation data.

## Required Features

- search my conversations
- search messages within conversations I belong to
- search users where product rules allow it
- create notification records
- list my notifications
- mark notification read/unread
- optional push notification job placeholder
- notification preferences

## Search Security

- search only data the authenticated user can access
- never search across private conversations globally
- validate and sanitize search query
- cap query length
- rate limit search endpoints
- paginate results
- do not expose deleted message text
- do not expose private user fields

## Notification Rules

- notifications belong to a user
- users can only read their own notifications
- push payloads should contain minimal private data
- avoid sending full message bodies in push notifications unless user settings allow it
- support muted conversations
- support notification preferences

## API Routes

```txt
GET   /api/v1/search/conversations
GET   /api/v1/search/messages
GET   /api/v1/search/users

GET   /api/v1/notifications
PATCH /api/v1/notifications/:notificationId/read
POST  /api/v1/notifications/read-all
GET   /api/v1/notification-preferences
PATCH /api/v1/notification-preferences
```

## Data Model Guidance

Notification:

- userId
- type
- title
- bodyPreview
- entityType
- entityId
- readAt
- createdAt

NotificationPreference:

- userId
- pushEnabled
- emailEnabled
- messagePreviewEnabled
- mutedConversationIds or separate muted membership field

## Testing

Add tests for:

- search respects conversation membership
- search does not return deleted/private data
- search query validation
- notifications are user-scoped
- mark read authorization
- muted conversation notification behavior if implemented

## Done Criteria

- search is private and paginated
- notifications do not leak private content
- rate limits and validation are in place
- tests pass
