# Prompt 13: Contacts, Invites, And Messaging Privacy

You are an expert backend engineer building contact discovery and messaging privacy for a production messenger app.

Inspect the current codebase first and follow existing patterns.

## Goal

Add contacts, friend/contact requests, invite links, and privacy controls that decide who can discover or message whom.

## Required Features

- send contact/friend request
- accept contact request
- decline contact request
- cancel sent request
- remove contact
- list contacts
- list incoming/outgoing requests
- invite link creation for groups if group conversations exist
- join group by invite link
- messaging privacy settings
- discovery privacy settings

## Data Model Guidance

Contact:

- userId
- contactUserId
- status
- createdAt
- updatedAt

ContactRequest:

- senderId
- receiverId
- status: `pending`, `accepted`, `declined`, `cancelled`
- message optional
- createdAt
- respondedAt

InviteLink:

- conversationId
- createdBy
- tokenHash
- expiresAt
- maxUses
- useCount
- revokedAt
- createdAt

PrivacySettings:

- userId
- whoCanFindMe
- whoCanMessageMe
- readReceiptsEnabled
- onlineStatusVisibility
- profilePhotoVisibility

## Security Rules

- users cannot send requests as someone else
- users cannot send contact requests to themselves
- duplicate pending requests should be prevented
- block status overrides contact and invite behavior
- invite tokens must be random and stored hashed
- expired/revoked invite links cannot be used
- private profiles should not leak through search
- messaging privacy must be checked before direct conversation creation and direct messages

## API Routes

```txt
POST   /api/v1/contacts/requests
GET    /api/v1/contacts/requests/incoming
GET    /api/v1/contacts/requests/outgoing
POST   /api/v1/contacts/requests/:requestId/accept
POST   /api/v1/contacts/requests/:requestId/decline
DELETE /api/v1/contacts/requests/:requestId
GET    /api/v1/contacts
DELETE /api/v1/contacts/:userId

POST   /api/v1/conversations/:conversationId/invites
POST   /api/v1/invites/:token/join
DELETE /api/v1/invites/:inviteId

GET    /api/v1/privacy-settings
PATCH  /api/v1/privacy-settings
```

## Testing

Add tests for:

- duplicate request prevention
- self-request rejection
- blocked users cannot request/contact/message
- accept/decline/cancel permissions
- invite token expiry
- revoked invite blocked
- privacy settings affect user search and direct conversations

## Done Criteria

- contacts and requests are permission-safe
- invite links are hashed and expirable
- privacy settings are enforced in relevant modules
- tests pass
