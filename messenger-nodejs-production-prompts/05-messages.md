# Prompt 05: Messages

You are an expert backend engineer building a secure, scalable messaging module.

Inspect the current code first and follow existing conventions.

## Goal

Build message sending, listing, editing, deleting, replies, reactions, receipts, and delivery/read state.

## Required Features

- send text message
- send message with attachment references if media module exists
- list messages in a conversation with cursor pagination
- get message by ID
- edit own message within product rules
- soft delete own message
- admin/moderator delete support if roles exist
- reply-to message support
- message reactions
- delivery receipts
- read receipts
- last message preview updates on conversation

## Data Model Guidance

Message:

- conversationId
- senderId
- text
- attachments
- replyToMessageId
- editedAt
- deletedAt
- deletedBy
- createdAt
- updatedAt

MessageReceipt:

- messageId
- userId
- deliveredAt
- readAt

Reaction:

- messageId
- userId
- emoji
- createdAt

## Security Rules

- only conversation members can send/list/read messages
- blocked users cannot send messages where product rules forbid it
- users can edit/delete only their own messages unless they have moderator/admin permissions
- deleted messages should not expose original text to normal users
- validate and sanitize message text
- store message text as plain text by default
- do not accept raw HTML
- validate attachment IDs belong to sender and are allowed in that conversation

## API Routes

```txt
POST   /api/v1/conversations/:conversationId/messages
GET    /api/v1/conversations/:conversationId/messages
GET    /api/v1/messages/:messageId
PATCH  /api/v1/messages/:messageId
DELETE /api/v1/messages/:messageId
POST   /api/v1/messages/:messageId/reactions
DELETE /api/v1/messages/:messageId/reactions/:reactionId
POST   /api/v1/messages/:messageId/delivered
POST   /api/v1/messages/:messageId/read
```

## Pagination

Use cursor-based pagination for message history.

Avoid offset pagination for large message lists.

## Validation

Validate:

- conversation ID
- message ID
- text length
- empty text with no attachments
- attachment ID list size
- reply target is in same conversation
- emoji/reaction allowlist or length
- cursor and limit

## Realtime Events

Emit events after successful database writes:

- `message.created`
- `message.updated`
- `message.deleted`
- `message.reaction_added`
- `message.reaction_removed`
- `message.delivered`
- `message.read`

Only emit to authorized conversation/user rooms.

## Testing

Add tests for:

- member can send
- non-member cannot send/list
- text validation
- edit/delete ownership
- reply validation
- reaction add/remove
- read receipts
- cursor pagination
- deleted message response shape

## Done Criteria

- membership checks are enforced
- message queries are indexed
- messages are paginated
- realtime events are emitted safely
- tests pass
