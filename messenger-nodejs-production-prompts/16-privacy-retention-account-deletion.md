# Prompt 16: Privacy, Retention, And Account Deletion

You are an expert privacy and backend data lifecycle engineer.

Inspect the existing messenger backend first. Review user, message, attachment, audit, report, and notification models before changing anything.

## Goal

Add privacy-friendly account deletion, data retention, export, and cleanup behavior.

## Required Features

- account deactivation
- account deletion request
- account deletion execution workflow
- anonymization or deletion strategy
- data export placeholder or implementation
- retention policy documentation
- cleanup jobs for expired sessions, orphan uploads, old notifications, expired invites, and deleted-account data
- privacy-safe handling of deleted users in conversations

## Product Decisions To Make Explicit

Document these decisions before implementing:

- are messages deleted, anonymized, or retained after account deletion?
- are audit logs retained?
- how long are reports retained?
- how long are attachments retained?
- can users export their data?
- is there a grace period before permanent deletion?

If decisions are not provided, choose conservative defaults and document them.

## Data Lifecycle Rules

- soft-delete user first
- revoke sessions immediately
- stop push notifications immediately
- remove or anonymize public profile fields
- preserve audit logs without private content
- preserve reports only when legally/product-required
- delete or anonymize private attachments according to policy
- avoid breaking existing conversations for other participants

## API Routes

```txt
POST /api/v1/users/me/deactivate
POST /api/v1/users/me/delete-request
POST /api/v1/users/me/delete-cancel
GET  /api/v1/users/me/data-export
```

## Cleanup Jobs

Add scheduled or worker-backed cleanup for:

- expired sessions
- revoked sessions after retention period
- expired invite links
- orphaned pending uploads
- old notifications
- deleted account finalization

## Testing

Add tests for:

- deletion request revokes sessions
- deleted user cannot login
- public profile is anonymized
- conversations still render safely
- cleanup jobs are idempotent
- data export excludes secrets/tokens

## Done Criteria

- privacy decisions are documented
- deletion/deactivation is safe
- cleanup jobs are idempotent
- tests pass
