# Prompt 05b: Disappearing Messages

You are an expert backend engineer building disappearing messages for a production messenger app.

Inspect the existing message, conversation, permission, socket, queue, and cleanup job code first. Follow existing patterns.

## Goal

Add disappearing message support with safe expiration rules, background cleanup, clear permissions, and privacy-conscious behavior.

## Required Features

- conversation-level disappearing message setting
- optional per-message expiration override if product rules allow it
- message expiration timestamp
- background cleanup or redaction job
- socket event for setting changes
- socket event for expired/deleted messages
- audit log for group setting changes
- system message or event when group setting changes if product rules require it

## Product Rules To Decide

Document these decisions before implementation:

- is expiration based on send time or read time?
- allowed durations, such as `off`, `24h`, `7d`, `30d`
- can members set disappearing messages in direct chats?
- can group admins only set disappearing messages in groups?
- are expired messages hard-deleted, soft-deleted, or redacted?
- are attachments deleted when the message expires?
- are reactions and receipts deleted with the message?

If not specified, use conservative defaults:

- expiration is based on send time
- allowed durations are `off`, `24h`, `7d`, `30d`
- direct chat participants can enable it for that conversation
- group `admin` and `super-admin` can change group setting
- expired messages are soft-deleted/redacted
- private attachments linked only to expired messages are marked for cleanup

## Data Model Guidance

Conversation:

- disappearingMessagesEnabled
- disappearingMessageDurationSeconds
- disappearingMessageUpdatedBy
- disappearingMessageUpdatedAt

Message:

- expiresAt
- expiredAt
- expirationPolicy
- deletedAt
- deletionReason: `user_deleted`, `moderator_deleted`, `expired`

Attachment:

- expiresAt if linked to expiring message
- cleanupAfter

## Permission Rules

- `member` can manage disappearing messages in direct conversations they belong to if product rules allow it
- group `admin` can manage disappearing message settings inside their group
- `moderator` cannot change private conversation settings unless explicitly allowed
- `super-admin` can perform emergency admin actions but should not bypass privacy rules casually
- route-level permission is not enough; always check conversation membership and group role

## API Routes

```txt
PATCH /api/v1/conversations/:conversationId/disappearing-messages
POST  /api/v1/messages/:messageId/expire-now
```

Use `expire-now` only for owner/moderator/admin behavior if product rules require it.

## Realtime Events

```txt
conversation.disappearing_settings_updated
message.expired
```

Only emit to authorized conversation rooms.

## Cleanup Job

Add an idempotent job that:

- finds expired messages in batches
- redacts or soft-deletes message body
- updates `expiredAt`
- handles related attachments according to policy
- avoids double-processing
- logs safe metadata only

## Validation

Validate:

- conversation ID
- duration enum
- message ID
- permission and membership
- group role where needed

## Testing

Add tests for:

- enable/disable disappearing messages
- invalid duration rejected
- non-member cannot change setting
- normal group member cannot change group setting
- group admin can change group setting
- new messages get correct `expiresAt`
- cleanup job expires messages idempotently
- expired message response does not expose original text
- expired message socket event is authorized

## Done Criteria

- disappearing message policy is documented
- settings are permission-safe
- expired messages do not leak plaintext
- cleanup job is idempotent
- tests pass
