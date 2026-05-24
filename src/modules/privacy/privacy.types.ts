// Privacy / retention constants. Centralised so the deletion service, the
// finalize-deletion job, and the documented retention policy all reference the
// same numbers — changing the grace window or a retention horizon is a
// one-file edit.

const SECONDS_PER_DAY = 24 * 60 * 60;

// Grace window between /me/delete-request and irreversible finalization.
// Conservative default: 30 days lets a user who clicked "delete" by mistake
// sign back in to cancel. A shorter window can be set for compliance regimes
// that require faster removal.
export const ACCOUNT_DELETION_GRACE_DAYS = 30;
export const ACCOUNT_DELETION_GRACE_SECONDS =
  ACCOUNT_DELETION_GRACE_DAYS * SECONDS_PER_DAY;

// Notifications: an inbox row older than this is reaped — users who never read
// it within ~3 months almost certainly won't. We tune up if the product later
// wants longer history.
export const NOTIFICATION_RETENTION_DAYS = 90;
export const NOTIFICATION_RETENTION_SECONDS =
  NOTIFICATION_RETENTION_DAYS * SECONDS_PER_DAY;

// Revoked sessions retain history for this long after revocation so a user
// reviewing their security log can see "signed out 2 weeks ago, IP X". Active
// sessions are bounded separately by the TTL index on `expiresAt`.
export const REVOKED_SESSION_RETENTION_DAYS = 30;
export const REVOKED_SESSION_RETENTION_SECONDS =
  REVOKED_SESSION_RETENTION_DAYS * SECONDS_PER_DAY;

// Invite links: revoked OR expired links older than this are deleted. Active
// invites are kept indefinitely — admins can see and revoke them via the
// conversation surface.
export const INVITE_RETENTION_DAYS = 30;
export const INVITE_RETENTION_SECONDS =
  INVITE_RETENTION_DAYS * SECONDS_PER_DAY;

// Reports retained 365 days past resolution for compliance / audit. The
// finalize-deletion job does NOT wipe reports submitted by a deleting user —
// they stay (reporterId points at the now-deleted user, whose display name
// will read "Deleted user").
export const REPORT_RETENTION_DAYS = 365;

// Page sizes for cleanup workers. Bounded so a single tick cannot consume an
// unbounded amount of memory or hold a long write lock.
export const CLEANUP_BATCH_SIZE = 200;

export interface AccountDeletionStatusDto {
  // Snapshot of the deletion lifecycle for the calling user — what the client
  // renders the "your account is scheduled for deletion on …" banner from.
  deletionRequested: boolean;
  requestedAt?: string;
  scheduledFor?: string;
  graceDaysRemaining?: number;
  // Resolved status string. `none` for the common case (no pending request).
  state: 'none' | 'pending' | 'finalized';
}

export interface DataExportDto {
  // Self-describing envelope: the consumer (admin tooling, a client doing
  // an in-app GDPR export, or a manual operator) shouldn't have to guess
  // which schema version they're looking at.
  schemaVersion: 1;
  generatedAt: string;
  user: {
    id: string;
    email?: string;
    phone?: string;
    username?: string;
    displayName: string;
    avatarUrl?: string;
    bio?: string;
    role: string;
    createdAt: string;
    updatedAt: string;
    deletionRequestedAt?: string;
    deletionScheduledFor?: string;
  };
  privacySettings: Record<string, unknown>;
  // Session metadata only — refreshTokenHash is NEVER exported.
  sessions: Array<{
    id: string;
    userAgent?: string;
    ipAddress?: string;
    createdAt: string;
    expiresAt: string;
    revokedAt?: string;
    revokedReason?: string;
  }>;
  // Device metadata only — pushToken is NEVER exported.
  devices: Array<{
    id: string;
    platform: string;
    pushProvider: string;
    deviceName?: string;
    appVersion?: string;
    locale?: string;
    lastSeenAt: string;
    createdAt: string;
    revokedAt?: string;
  }>;
  contacts: Array<{ contactUserId: string; createdAt: string }>;
  blocks: Array<{
    blockedUserId: string;
    reason?: string;
    createdAt: string;
  }>;
  // Conversations the caller is/was a member of — ids only, so the export
  // never includes other participants' messages or membership lists.
  conversations: Array<{
    conversationId: string;
    membershipRole: string;
    joinedAt: string;
    leftAt?: string;
  }>;
  // Messages the caller authored, with text. We do NOT include attachments —
  // those still belong to the conversation and the user can fetch them via
  // the regular media surface while their account exists.
  sentMessages: Array<{
    id: string;
    conversationId: string;
    text: string;
    createdAt: string;
    deletedAt?: string;
    editedAt?: string;
  }>;
  // Outstanding reports filed BY the caller. Reports against the caller are
  // NOT included — they belong to the reporter, not the reported user.
  reportsFiled: Array<{
    id: string;
    targetType: string;
    targetId: string;
    reason: string;
    status: string;
    createdAt: string;
  }>;
}
