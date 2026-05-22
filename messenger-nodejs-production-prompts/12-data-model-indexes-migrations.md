# Prompt 12: Data Model, Indexes, And Migrations

You are an expert MongoDB, Mongoose, and production database engineer.

Inspect the current messenger backend first. Review all models, query patterns, indexes, migrations/scripts, and seed data before changing anything.

## Goal

Harden the database layer so the messenger app can scale safely and avoid slow queries, duplicate records, unsafe deletes, and migration chaos.

## Required Work

- review all MongoDB/Mongoose models
- confirm schema strict mode is enabled where appropriate
- add required unique indexes
- add query-supporting indexes
- add TTL indexes for temporary records
- add soft-delete fields where needed
- add created/updated timestamps consistently
- document all important query patterns
- create migration/backfill scripts if model changes need existing data updates
- create seed/test data helpers where useful

## Core Collections To Review

```txt
users
sessions
roles or permission mappings
conversations
conversation_members
messages
message_receipts
attachments
stories
story_views
story_mutes
blocks
reports
notifications
audit_logs
devices
```

## Index Guidance

Add indexes based on real query patterns.

Common indexes:

- `users.email` unique and sparse where applicable
- `users.username` unique and sparse where applicable
- `sessions.userId`
- `sessions.refreshTokenHash`
- `sessions.expiresAt` TTL or cleanup-supported
- `conversations.type`
- `conversation_members.userId + archivedAt`
- `conversation_members.conversationId + userId` unique
- `messages.conversationId + createdAt`
- `messages.conversationId + _id`
- `messages.senderId + createdAt`
- `messages.expiresAt`
- `message_receipts.messageId + userId` unique
- `stories.authorId + createdAt`
- `stories.expiresAt`
- `story_views.storyId + viewerId` unique
- `story_mutes.userId + mutedUserId` unique
- `blocks.blockerId + blockedUserId` unique
- `reports.status + createdAt`
- `notifications.userId + readAt + createdAt`
- `audit_logs.createdAt`

Do not add expensive text indexes casually. If text search is needed, design it intentionally.

## Migration Rules

For every model change:

- describe the data impact
- add safe backfill logic if needed
- make scripts idempotent
- avoid destructive migrations without explicit approval
- support rollback notes where practical
- do not block the app on huge synchronous migrations at startup

## Data Integrity Rules

- enforce direct conversation uniqueness
- enforce one active membership per user/conversation
- enforce one block per blocker/blocked pair
- enforce attachment ownership
- enforce story visibility through audience/contact/block rules
- prevent duplicate story views per viewer/story
- ensure expiring messages and stories are cleanup-safe
- prevent orphaned pending uploads from living forever
- prevent receipts for users who are not conversation members

## Testing

Add tests for:

- unique constraints
- important indexes if practical
- direct conversation deduplication
- membership uniqueness
- disappearing message expiration behavior
- story view uniqueness
- story expiration behavior
- TTL/cleanup script behavior
- migration/backfill idempotency

## Done Criteria

- models and indexes match query patterns
- migrations/backfills are safe and documented
- data integrity constraints are tested
- no unbounded high-risk query remains undocumented
