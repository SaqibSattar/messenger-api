# Prompt 08: Blocking, Reporting, And Moderation

You are an expert backend engineer building safety and abuse-prevention features for a messenger app.

Inspect the existing code first and follow established patterns.

## Goal

Add user blocking, reporting, moderation actions, and audit-safe safety workflows.

## Required Features

- block user
- unblock user
- list blocked users
- prevent blocked direct messaging
- hide or restrict blocked user interactions according to product rules
- report user
- report message
- report conversation
- moderation queue for admins/moderators
- moderation status updates
- audit log for moderation actions

## Data Model Guidance

Block:

- blockerId
- blockedUserId
- reason optional
- createdAt

Report:

- reporterId
- targetType: `user`, `message`, `conversation`
- targetId
- reason
- details
- status: `open`, `reviewing`, `resolved`, `dismissed`
- assignedTo
- createdAt
- resolvedAt

ModerationAction:

- moderatorId
- actionType
- targetType
- targetId
- reason
- metadata
- createdAt

## Security Rules

- users cannot report as someone else
- users cannot inspect reports they do not own unless moderator/admin
- moderators need explicit permission
- report details may contain sensitive content; sanitize and restrict access
- moderation actions must be audited
- blocked status must be checked before direct conversation creation and message sending

## API Routes

```txt
POST   /api/v1/blocks
GET    /api/v1/blocks
DELETE /api/v1/blocks/:blockedUserId

POST   /api/v1/reports
GET    /api/v1/reports
GET    /api/v1/reports/:reportId
PATCH  /api/v1/reports/:reportId/status

POST   /api/v1/moderation/actions
```

## Validation

Validate:

- target type
- target ID
- reason enum
- details length
- status transitions
- moderator permissions

## Testing

Add tests for:

- block prevents direct messaging
- unblock restores allowed behavior
- users cannot block themselves
- report creation
- report access control
- moderation permission checks
- audit log creation

## Done Criteria

- blocked users cannot bypass rules
- reports are private by default
- moderation actions are audited
- tests pass
