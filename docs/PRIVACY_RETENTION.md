# Privacy, retention, and account deletion

This document is the **operational policy** for how user data is held, what
happens when a user winds down their account, and how the cleanup jobs
behave. It pairs with the spec in
[`messenger-nodejs-production-prompts/16-privacy-retention-account-deletion.md`](../messenger-nodejs-production-prompts/16-privacy-retention-account-deletion.md)
and the engineering rules in [`AGENTS.md`](../AGENTS.md).

Concrete numbers live in
[`src/modules/privacy/privacy.types.ts`](../src/modules/privacy/privacy.types.ts)
— changing the grace window or retention horizon is a one-file edit.

---

## Account states

| Status | Meaning | Auth allows? | Findable? |
| --- | --- | --- | --- |
| `active` | Normal account. | Yes | Yes |
| `suspended` | Moderator action. | No | No |
| `deactivated` | User soft-deactivated via `/me/deactivate`. Reversible by an operator. | No | No |
| `pending_deletion` | User called `/me/delete-request`; in the grace window. | Yes (so they can cancel) | No |
| `deleted` | Finalize sweep ran. Document is anonymized. | No | No |

Auth middleware admits `active` and `pending_deletion`. Login mirrors the
same rule. Refresh follows login.

---

## Lifecycle endpoints

All four sit under `/api/v1/users/me/*`. They require a valid bearer token.
None of them are exposed to public callers.

| Endpoint | Effect |
| --- | --- |
| `POST /me/deactivate` | Soft-deactivate. Password-confirmed. Revokes every active session. Reversible only by an operator. |
| `POST /me/delete-request` | Schedules irreversible deletion `ACCOUNT_DELETION_GRACE_DAYS` from now (default **30 days**). Password-confirmed. Revokes every active session and soft-revokes every push device immediately. |
| `POST /me/delete-cancel` | Cancels a pending deletion. Returns the account to `active`. Refused after the scheduled timestamp has passed. |
| `GET  /me/data-export` | Returns the JSON envelope described below. Rate-limited to 3/hour per user. |

### Why password-confirm on deactivate AND delete-request

A leaked access token alone must never be enough to wipe an account.
Re-entering the password is the only "I'm really me" signal that's available
to an API-only service.

### Why the grace period

A 30-day window is the **conservative default** for any deletion request
made by a user who may have clicked the wrong button, lost their device, or
been coerced. A shorter window can be set per deployment if a compliance
regime requires it (e.g. some GDPR processors target 14 days).

During the grace window:

- The user can sign back in (auth allows `pending_deletion`).
- They can hit `/me/delete-cancel` to abort.
- They can hit `/me/data-export` to export their data.
- They are **hidden from discovery** (search, public profile lookups) — the
  account is winding down and shouldn't be surfaced.
- New direct conversations cannot be opened with them — same rationale.
- Push devices have been revoked, so notifications stop firing immediately.

---

## What the data export contains

Schema version 1. See
[`DataExportDto`](../src/modules/privacy/privacy.types.ts) for the typed
shape. The envelope deliberately excludes:

- `passwordHash` (and any derivative)
- `refreshTokenHash` (sessions are exported as metadata only)
- `pushToken` (devices are exported as metadata only)
- Other users' messages — only messages the caller **authored** are in
  `sentMessages`.
- Audit-log free-text for events the caller wasn't actor on.

If the caller has authored more than 50,000 messages, the export is capped
at the most recent 50k. A larger export must be staffed via support.

The audit row for `user.data.exported` records counts only, never the body.

---

## What finalization does

`POST /me/delete-request` only writes the schedule. Once the
`finalizeAccountDeletions` job sees a user whose `deletionScheduledFor` has
passed, it does **all** of the following atomically per user (each step is
independently idempotent):

| Step | Why |
| --- | --- |
| Atomic claim: `status: pending_deletion → deleted` (guarded) | A concurrent run can't double-process the same user. |
| Anonymize user document in place | The `_id` stays stable so historical messages still resolve a sender row. `email`/`phone`/`username` reset to `null` so the unique indexes free up. `displayName = "Deleted user"`. Avatar, bio, custom permissions, verification timestamps cleared. Password hash replaced with random opaque bytes (cannot be matched by argon2.verify). Privacy settings reset to defaults. |
| Hard-delete sessions | Token rotation chain is irrelevant once the user is gone. |
| Hard-delete devices | Push fan-out must stop. |
| Hard-delete notifications + preferences | Inbox is moot. |
| Delete contacts (both directions) + pending contact requests | Other users would otherwise see dangling references. |
| Delete blocks initiated by AND against the user | Moot — no enforcer / no target. |
| Revoke pending invite links created by the user | Kept for audit but no longer redeemable. |
| Mark private orphan attachments deleted | Anything attached to a conversation message is preserved — see below. |

### What we **do not** delete

| What | Why |
| --- | --- |
| Conversation membership rows | Removing them would change other participants' member counts and break "who was in this group?" answers. |
| Messages the user sent | Removing them would surgically rewrite other participants' history. Senders render as "Deleted user" client-side via the anonymized DTO. |
| Attachments already attached to a message | Same as above — removing them breaks rendering for everyone else in the conversation. |
| Audit logs | Security-event trail outlives the user document. Audit metadata never contains private content (see [`src/modules/admin/auditLog.service.ts`](../src/modules/admin/auditLog.service.ts)). |
| Reports filed by the user | Preserved per the report-retention rule below. |

### Cancellation

The cancel endpoint returns `409 CONFLICT` if `deletionScheduledFor` has
already passed — finalization may have started. Cancels accepted earlier
clear the deletion fields and flip status back to `active`. Sessions stay
revoked (the cancel itself came in over a fresh session the user obtained
by signing back in).

---

## Retention windows

| Item | Retention | Cleanup job |
| --- | --- | --- |
| Active sessions | Bounded by `expiresAt` (TTL index, Mongo evicts automatically). | n/a |
| Revoked sessions | 30 days past `revokedAt`. Lets a user review "where am I signed in" history. | `cleanupSessions` |
| Notifications | 90 days. Bounded inbox prevents unbounded growth from never-read rows. | `cleanupNotifications` |
| Invite links (revoked or expired) | 30 days. Admins can audit recent invites. | `cleanupInvites` |
| Pending attachment uploads (never completed) | `MEDIA_PENDING_TTL_SECONDS` (default 1 hour). | `cleanupAttachments` |
| Stale device tokens | `DEVICE_STALE_AFTER_DAYS` (default 90 days). | `cleanupDevices` |
| Expired messages (disappearing messages) | Redacted on schedule. | `expireMessages` |
| Audit logs | Indefinite. Security incidents may take months to surface. |  — |
| Reports | Retained 365 days past resolution. Active reports stay open. |  — |

The cleanup jobs are all **scheduled by the host process** (not by the API
process). Each is idempotent — running on multiple workers only deletes the
same row once because every per-doc update is guarded by a filter that
becomes false once the work is done.

---

## Privacy-friendly defaults

- Public profile DTOs strip `email`, `phone`, `role`, `status`,
  `privacySettings`, `lastLoginAt`, `customPermissions`, and password
  material. See [`toPublicUserDto`](../src/modules/users/user.model.ts).
- Per-user audience controls (`whoCanFindMe`, `whoCanMessageMe`,
  `profilePhotoVisibility`, `onlineStatusVisibility`,
  `readReceiptsEnabled`) gate discovery, DM creation, profile-photo
  visibility, presence, and read-receipt writes. Default audience is
  `everyone`; per-field discoverability is `true`. See
  [`DEFAULT_PRIVACY_SETTINGS`](../src/modules/users/user.types.ts).
- Notifications never carry message bodies for sensitive types
  (report-status changes, moderation actions). See
  [`createNotification`](../src/modules/notifications/notification.service.ts).
- The push worker never logs `pushToken`. The device model marks the field
  `select: false`.
- The audit-log sanitiser strips keys whose names match `password`,
  `token`, `secret`, `cookie`, etc., and rejects Mongo operator/dot keys
  before writing. See
  [`sanitizeAuditMetadata`](../src/modules/admin/auditLog.service.ts).

---

## Compliance notes (non-binding)

This service is built to make GDPR / CCPA-style requests practical:

- **Right of access** — `/me/data-export` returns the bounded JSON envelope.
- **Right to erasure** — `/me/delete-request` + the finalize job remove or
  anonymize per the table above. Conversations and messages that belong to
  other users are kept; the deleting user's name is anonymized everywhere
  it appears.
- **Right to rectification** — `/me/profile` lets a user correct most
  fields. Email/phone changes flow through the regular update endpoint
  with re-verification.

This document is descriptive of the implementation, not a legal opinion.
Confirm regional requirements with counsel before signing a DPA.
