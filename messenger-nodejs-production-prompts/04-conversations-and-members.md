# Prompt 04: Conversations And Members

You are an expert backend engineer building conversation and membership logic for a production messenger.

Inspect the current code first and follow established patterns.

## Goal

Build conversation creation, listing, membership, roles, and group management with strict authorization.

## Required Features

- create direct conversation
- create group conversation
- list my conversations
- get conversation details
- update group title/avatar/settings
- add group members
- remove group members
- leave group
- assign group member roles
- archive/mute conversation for current user
- track last read message pointer

## Data Model Guidance

Conversation:

- type: `direct` or `group`
- title
- avatarUrl
- createdBy
- lastMessage
- settings
- createdAt
- updatedAt

ConversationMember:

- conversationId
- userId
- role: `owner`, `admin`, `member`
- joinedAt
- leftAt
- mutedUntil
- archivedAt
- lastReadMessageId

For direct conversations, enforce uniqueness between the same two active users.

## Authorization Rules

- only members can view conversation details
- only members can list messages
- only members can send messages
- group owner/admin can add or remove members
- only owner can transfer ownership or delete group
- users can leave groups, but direct conversations cannot be left the same way unless product rules allow it
- blocked users cannot start direct conversations with users who blocked them

## API Routes

```txt
POST   /api/v1/conversations/direct
POST   /api/v1/conversations/groups
GET    /api/v1/conversations
GET    /api/v1/conversations/:conversationId
PATCH  /api/v1/conversations/:conversationId
POST   /api/v1/conversations/:conversationId/members
DELETE /api/v1/conversations/:conversationId/members/:userId
PATCH  /api/v1/conversations/:conversationId/members/:userId/role
POST   /api/v1/conversations/:conversationId/leave
PATCH  /api/v1/conversations/:conversationId/read
PATCH  /api/v1/conversations/:conversationId/preferences
```

## Validation

Validate:

- ObjectId params
- conversation type
- participant IDs
- group title length
- group member count limits
- role enum
- mute/archive payloads
- pagination params

## Testing

Add tests for:

- direct conversation uniqueness
- group creation
- non-member cannot read conversation
- member list permissions
- add/remove member permissions
- role update rules
- blocked user restrictions
- pagination

## Done Criteria

- conversation membership is enforced everywhere
- direct conversations are deduplicated
- group admin rules are tested
- list queries are paginated and indexed
