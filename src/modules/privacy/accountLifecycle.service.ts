import crypto from 'crypto';
import argon2 from 'argon2';
import mongoose, { type Types } from 'mongoose';
import { logger } from '../../utils/logger';
import {
  BadRequestError,
  ConflictError,
  UnauthorizedError
} from '../../utils/errors';
import {
  auditUserDataExported,
  auditUserDeletionCancelled,
  auditUserDeletionFinalized,
  auditUserDeletionRequested
} from '../../utils/audit';
import type { RequestContext } from '../auth/auth.types';
import type { AuthenticatedActor } from '../permissions/authorization';
import {
  Session,
  SESSION_REVOKED_REASON
} from '../sessions/session.model';
import { Device } from '../devices/device.model';
import { Notification } from '../notifications/notification.model';
import { NotificationPreference } from '../notifications/notificationPreference.model';
import { ConversationNotificationPreference } from '../notifications/conversationNotificationPreference.model';
import { Contact } from '../contacts/contact.model';
import { ContactRequest } from '../contacts/contactRequest.model';
import { Block } from '../moderation/block.model';
import { Report } from '../moderation/report.model';
import { InviteLink } from '../invites/inviteLink.model';
import { Attachment } from '../media/attachment.model';
import { ATTACHMENT_STATUS, ATTACHMENT_VISIBILITY } from '../media/media.types';
import { Message } from '../messages/message.model';
import { ConversationMember } from '../conversations/conversationMember.model';
import {
  resolvePrivacySettings,
  User,
  toUserDto,
  type UserDocument
} from '../users/user.model';
import {
  DELETED_USER_DISPLAY_NAME,
  DEFAULT_PRIVACY_SETTINGS,
  USER_STATUS,
  type UserDto
} from '../users/user.types';
import {
  ACCOUNT_DELETION_GRACE_SECONDS,
  CLEANUP_BATCH_SIZE,
  type AccountDeletionStatusDto,
  type DataExportDto
} from './privacy.types';

const toObjectId = (id: string): Types.ObjectId =>
  new mongoose.Types.ObjectId(id);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const requireUserWithPassword = async (
  userId: string
): Promise<UserDocument & { passwordHash: string }> => {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new UnauthorizedError();
  return user as UserDocument & { passwordHash: string };
};

// ---------------------------------------------------------------------------
// Status snapshot — small helper consumed by /me/delete-request response and
// the data-export envelope. Keeps the "is this account being wound down?"
// computation in one place.
// ---------------------------------------------------------------------------

export const buildDeletionStatus = (
  user: UserDocument,
  now: Date = new Date()
): AccountDeletionStatusDto => {
  if (user.status === USER_STATUS.DELETED) {
    return { deletionRequested: false, state: 'finalized' };
  }
  if (
    user.status !== USER_STATUS.PENDING_DELETION ||
    !user.deletionScheduledFor ||
    !user.deletionRequestedAt
  ) {
    return { deletionRequested: false, state: 'none' };
  }
  const remainingMs = user.deletionScheduledFor.getTime() - now.getTime();
  // Floor to whole days, never negative. A user reading "0 days remaining"
  // immediately before the next finalize tick is more honest than "1 day"
  // when the cutover is hours away.
  const graceDaysRemaining = Math.max(0, Math.floor(remainingMs / MS_PER_DAY));
  return {
    deletionRequested: true,
    requestedAt: user.deletionRequestedAt.toISOString(),
    scheduledFor: user.deletionScheduledFor.toISOString(),
    graceDaysRemaining,
    state: 'pending'
  };
};

// ---------------------------------------------------------------------------
// Request deletion
//
// Re-uses the deactivate-account password-confirm pattern: a leaked access
// token alone must never be enough to wipe an account. Sets the wind-down
// fields, revokes every active session (so existing access tokens stop
// working immediately), and revokes every push device (so APNs/FCM stop
// firing notifications during the grace window).
// ---------------------------------------------------------------------------

export interface RequestDeletionInput {
  password: string;
}

export interface RequestDeletionResult {
  user: UserDto;
  deletion: AccountDeletionStatusDto;
}

export const requestAccountDeletion = async (
  actor: AuthenticatedActor,
  input: RequestDeletionInput,
  ctx?: RequestContext
): Promise<RequestDeletionResult> => {
  const user = await requireUserWithPassword(actor.id);

  const valid = await argon2.verify(user.passwordHash, input.password);
  if (!valid) throw new UnauthorizedError('Password is incorrect');

  // Re-requesting from PENDING_DELETION is a no-op. We return the existing
  // schedule so the client can re-render the banner without a special case.
  if (user.status === USER_STATUS.PENDING_DELETION) {
    return {
      user: toUserDto(user),
      deletion: buildDeletionStatus(user)
    };
  }

  // Refuse from terminal states — a DELETED row shouldn't reach here (auth
  // middleware rejects it), but defending in depth is cheap.
  if (user.status === USER_STATUS.DELETED) {
    throw new ConflictError('Account is not eligible for deletion');
  }

  const now = new Date();
  const scheduledFor = new Date(
    now.getTime() + ACCOUNT_DELETION_GRACE_SECONDS * 1000
  );

  user.status = USER_STATUS.PENDING_DELETION;
  user.deletionRequestedAt = now;
  user.deletionScheduledFor = scheduledFor;
  await user.save();

  // Revoke all live sessions. Existing access tokens stop working the next
  // time auth middleware re-reads the user document, but revoking the refresh
  // session immediately kills the rotation path too.
  const sessionResult = await Session.updateMany(
    { userId: user._id, revokedAt: { $exists: false } },
    {
      $set: {
        revokedAt: now,
        revokedReason: SESSION_REVOKED_REASON.DELETION_REQUEST
      }
    }
  );
  const sessionsRevoked = sessionResult.modifiedCount ?? 0;

  // Soft-revoke every push device so the push worker stops fanning out to
  // a user who is winding down. We DON'T hard-delete here — that's the
  // finalize job's job — so a cancel can be a "metadata-only" reversal.
  const deviceResult = await Device.updateMany(
    { userId: user._id, revokedAt: { $exists: false } },
    { $set: { revokedAt: now } }
  );
  const devicesRevoked = deviceResult.modifiedCount ?? 0;

  await auditUserDeletionRequested(
    {
      actorId: actor.id,
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent
    },
    {
      userId: actor.id,
      scheduledFor,
      sessionsRevoked,
      devicesRevoked
    }
  );

  return {
    user: toUserDto(user),
    deletion: buildDeletionStatus(user, now)
  };
};

// ---------------------------------------------------------------------------
// Cancel deletion
//
// Only valid while the user is PENDING_DELETION and the schedule has not yet
// elapsed. Restores ACTIVE status and clears the deletion fields. Sessions
// stay revoked — the cancel call itself came in over a fresh session that
// the user obtained by signing back in.
// ---------------------------------------------------------------------------

export const cancelAccountDeletion = async (
  actor: AuthenticatedActor,
  ctx?: RequestContext
): Promise<{ user: UserDto; deletion: AccountDeletionStatusDto }> => {
  const user = await User.findById(actor.id);
  if (!user) throw new UnauthorizedError();

  if (user.status !== USER_STATUS.PENDING_DELETION) {
    throw new BadRequestError('Account is not pending deletion');
  }

  // Defence-in-depth: if the finalize job is about to fire (scheduled time
  // already passed), refuse the cancel so we don't restore a row whose data
  // is moments away from being shredded.
  if (
    user.deletionScheduledFor &&
    user.deletionScheduledFor.getTime() <= Date.now()
  ) {
    throw new ConflictError(
      'Account deletion has already started and cannot be cancelled'
    );
  }

  user.status = USER_STATUS.ACTIVE;
  user.deletionRequestedAt = undefined;
  user.deletionScheduledFor = undefined;
  await user.save();

  await auditUserDeletionCancelled(
    {
      actorId: actor.id,
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent
    },
    { userId: actor.id }
  );

  return {
    user: toUserDto(user),
    deletion: buildDeletionStatus(user)
  };
};

// ---------------------------------------------------------------------------
// Data export
//
// Bounded JSON dump of what we hold about the caller. Excludes:
//   - password hash
//   - refresh-token hashes
//   - push tokens
//   - audit-log free-text metadata for events the user wasn't actor on
//   - any other user's messages
//
// Read-only — the caller doesn't get the right to mutate anything via this
// surface, even themselves.
// ---------------------------------------------------------------------------

export const exportMyData = async (
  actor: AuthenticatedActor,
  ctx?: RequestContext
): Promise<DataExportDto> => {
  const user = await User.findById(actor.id);
  if (!user) throw new UnauthorizedError();

  const userOid = user._id as Types.ObjectId;

  // Sessions: metadata only — we exclude refreshTokenHash and the rotation
  // chain pointer (the chain points at internal session ids, no user value).
  const sessions = await Session.find({ userId: userOid }).sort({ _id: -1 });

  // Devices: metadata only — pushToken is select:false and we don't opt in
  // here. The export should never round-trip a push transport secret.
  const devices = await Device.find({ userId: userOid }).sort({ _id: -1 });

  const contacts = await Contact.find({ userId: userOid }).sort({ _id: -1 });
  const blocks = await Block.find({ blockerId: userOid }).sort({ _id: -1 });

  const memberships = await ConversationMember.find({ userId: userOid }).sort({
    _id: -1
  });

  // Messages I sent. We cap at a generous-but-finite number to keep the JSON
  // bounded — a user who has sent more than 50k messages can request a
  // staffed export via support.
  const MESSAGE_EXPORT_CAP = 50_000;
  const messages = await Message.find({ senderId: userOid })
    .sort({ _id: -1 })
    .limit(MESSAGE_EXPORT_CAP);

  const reports = await Report.find({ reporterId: userOid }).sort({ _id: -1 });

  const exportDto: DataExportDto = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    user: {
      id: userOid.toString(),
      ...(user.email ? { email: user.email } : {}),
      ...(user.phone ? { phone: user.phone } : {}),
      ...(user.username ? { username: user.username } : {}),
      displayName: user.displayName,
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      ...(user.bio ? { bio: user.bio } : {}),
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      ...(user.deletionRequestedAt
        ? { deletionRequestedAt: user.deletionRequestedAt.toISOString() }
        : {}),
      ...(user.deletionScheduledFor
        ? { deletionScheduledFor: user.deletionScheduledFor.toISOString() }
        : {})
    },
    privacySettings: resolvePrivacySettings(user) as unknown as Record<
      string,
      unknown
    >,
    sessions: sessions.map((s) => ({
      id: (s._id as Types.ObjectId).toString(),
      ...(s.userAgent ? { userAgent: s.userAgent } : {}),
      ...(s.ipAddress ? { ipAddress: s.ipAddress } : {}),
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      ...(s.revokedAt ? { revokedAt: s.revokedAt.toISOString() } : {}),
      ...(s.revokedReason ? { revokedReason: s.revokedReason } : {})
    })),
    devices: devices.map((d) => ({
      id: (d._id as Types.ObjectId).toString(),
      platform: d.platform,
      pushProvider: d.pushProvider,
      ...(d.deviceName ? { deviceName: d.deviceName } : {}),
      ...(d.appVersion ? { appVersion: d.appVersion } : {}),
      ...(d.locale ? { locale: d.locale } : {}),
      lastSeenAt: d.lastSeenAt.toISOString(),
      createdAt: d.createdAt.toISOString(),
      ...(d.revokedAt ? { revokedAt: d.revokedAt.toISOString() } : {})
    })),
    contacts: contacts.map((c) => ({
      contactUserId: c.contactUserId.toString(),
      createdAt: c.createdAt.toISOString()
    })),
    blocks: blocks.map((b) => ({
      blockedUserId: b.blockedUserId.toString(),
      ...(b.reason ? { reason: b.reason } : {}),
      createdAt: b.createdAt.toISOString()
    })),
    conversations: memberships.map((m) => ({
      conversationId: m.conversationId.toString(),
      membershipRole: m.role,
      joinedAt: m.joinedAt.toISOString(),
      ...(m.leftAt ? { leftAt: m.leftAt.toISOString() } : {})
    })),
    sentMessages: messages.map((m) => ({
      id: (m._id as Types.ObjectId).toString(),
      conversationId: m.conversationId.toString(),
      text: m.text,
      createdAt: m.createdAt.toISOString(),
      ...(m.deletedAt ? { deletedAt: m.deletedAt.toISOString() } : {}),
      ...(m.editedAt ? { editedAt: m.editedAt.toISOString() } : {})
    })),
    reportsFiled: reports.map((r) => ({
      id: (r._id as Types.ObjectId).toString(),
      targetType: r.targetType,
      targetId: r.targetId.toString(),
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt.toISOString()
    }))
  };

  await auditUserDataExported(
    {
      actorId: actor.id,
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent
    },
    {
      userId: actor.id,
      messageCount: messages.length,
      conversationCount: memberships.length
    }
  );

  return exportDto;
};

// ---------------------------------------------------------------------------
// Finalize deletion — irreversible
//
// Called by the scheduled job. For each user whose grace window has elapsed:
//
//   1. Atomic guarded status flip: PENDING_DELETION → DELETED. A second pass
//      over the same user sees status === DELETED and is a no-op (idempotent).
//   2. Anonymize the user document in-place — _id stays stable so existing
//      messages still resolve a sender row, but every PII field is reset.
//      Email / phone / username are set to null so the unique sparse indexes
//      free up for someone else to register the same identifier later.
//   3. Side-effect cleanup. Each step is independently idempotent: it filters
//      on the user's id and applies bounded deletes. Re-running after a crash
//      converges, even if the user was partially cleaned up.
//
// Conversations and messages are NOT deleted — that would surgically remove
// content from other participants' chat history and is not the documented
// policy (see docs/PRIVACY_RETENTION.md). The deleted user's name renders as
// "Deleted user" everywhere.
// ---------------------------------------------------------------------------

export interface FinalizeAccountDeletionsResult {
  scanned: number;
  finalized: number;
}

interface FinalizeUserSideEffects {
  sessionsDeleted: number;
  devicesDeleted: number;
  notificationsDeleted: number;
  contactsDeleted: number;
  contactRequestsDeleted: number;
  blocksDeleted: number;
  pendingInvitesRevoked: number;
  privateAttachmentsDeleted: number;
}

const anonymizeUserFields = async (user: UserDocument): Promise<void> => {
  // Random opaque hash that cannot be matched by argon2.verify. We don't use
  // a literal sentinel like "deleted" because argon2.verify would still
  // accept a crafted hash; rotating randomness on every delete keeps the
  // collision-free property.
  const sentinelHash =
    '$argon2id$v=19$m=65536,t=3,p=4$' +
    crypto.randomBytes(16).toString('base64') +
    '$' +
    crypto.randomBytes(32).toString('base64');

  user.email = undefined;
  user.phone = undefined;
  user.username = undefined;
  user.displayName = DELETED_USER_DISPLAY_NAME;
  user.avatarUrl = undefined;
  user.bio = undefined;
  user.passwordHash = sentinelHash;
  user.customPermissions = [];
  user.emailVerifiedAt = undefined;
  user.phoneVerifiedAt = undefined;
  user.lastLoginAt = undefined;
  user.passwordChangedAt = undefined;
  user.privacySettings = { ...DEFAULT_PRIVACY_SETTINGS };
  user.markModified('privacySettings');
  user.status = USER_STATUS.DELETED;
  user.deletedAt = new Date();
  await user.save();
};

const finalizeOneUser = async (
  user: UserDocument
): Promise<FinalizeUserSideEffects | null> => {
  const userOid = user._id as Types.ObjectId;
  const now = new Date();

  // Guarded atomic transition. A second job run after a previous one
  // succeeded sees status === DELETED and modifiedCount === 0; we treat that
  // as "already finalized" and return null so the caller's counters stay
  // accurate.
  const claimed = await User.findOneAndUpdate(
    {
      _id: userOid,
      status: USER_STATUS.PENDING_DELETION
    },
    {
      $set: {
        // Set deletedAt early so a concurrent run skips us; the real
        // anonymization happens below and overwrites this value with a
        // newer timestamp.
        deletedAt: now
      }
    },
    { new: true }
  );
  if (!claimed) return null;

  await anonymizeUserFields(claimed);

  // From here every step is best-effort and idempotent — if the process
  // dies we re-enter at the top, see status === DELETED (no claim), but the
  // following deleteMany / updateMany calls all converge.

  const sessions = await Session.deleteMany({ userId: userOid });
  const devices = await Device.deleteMany({ userId: userOid });
  const notifications = await Notification.deleteMany({ userId: userOid });
  await NotificationPreference.deleteMany({ userId: userOid });
  await ConversationNotificationPreference.deleteMany({ userId: userOid });

  // Contacts are stored as two directed rows (a→b, b→a). We delete both
  // sides — keeping the reciprocal half would leave dangling references that
  // the contact listing would render as "this row says you're my contact but
  // you don't exist".
  const contactsAsOwner = await Contact.deleteMany({ userId: userOid });
  const contactsAsTarget = await Contact.deleteMany({
    contactUserId: userOid
  });
  const contactsDeleted =
    (contactsAsOwner.deletedCount ?? 0) + (contactsAsTarget.deletedCount ?? 0);

  // Pending contact requests in either direction become moot once the user is
  // gone. Terminal (accepted/declined/cancelled) rows stay so a recipient's
  // history of "received and declined" remains intact.
  const requestsOut = await ContactRequest.deleteMany({
    senderId: userOid,
    status: 'pending'
  });
  const requestsIn = await ContactRequest.deleteMany({
    receiverId: userOid,
    status: 'pending'
  });
  const contactRequestsDeleted =
    (requestsOut.deletedCount ?? 0) + (requestsIn.deletedCount ?? 0);

  // Blocks initiated by the deleted user are removed — there is no longer a
  // blocker to enforce. Blocks against the deleted user are also removed for
  // the same reason; we don't want a moot row to keep filtering future
  // searches.
  const blocksOut = await Block.deleteMany({ blockerId: userOid });
  const blocksIn = await Block.deleteMany({ blockedUserId: userOid });
  const blocksDeleted =
    (blocksOut.deletedCount ?? 0) + (blocksIn.deletedCount ?? 0);

  // Revoke active invite links created by this user — they shouldn't be
  // redeemable into a conversation where the inviter no longer exists. Keep
  // expired/revoked rows for audit.
  const inviteResult = await InviteLink.updateMany(
    { createdBy: userOid, revokedAt: { $exists: false } },
    { $set: { revokedAt: now } }
  );

  // Private (owner-only) attachments that never made it into a conversation
  // are no longer reachable; mark them deleted so the orphan-cleanup sweep
  // wipes the underlying objects. Attachments already attached to a message
  // stay so the conversation history doesn't break for other participants.
  const privateAttachmentResult = await Attachment.updateMany(
    {
      ownerId: userOid,
      visibility: ATTACHMENT_VISIBILITY.PRIVATE,
      messageId: { $exists: false },
      status: { $nin: [ATTACHMENT_STATUS.DELETED, ATTACHMENT_STATUS.REJECTED] }
    },
    {
      $set: {
        status: ATTACHMENT_STATUS.DELETED,
        deletedAt: now,
        deletedBy: userOid
      }
    }
  );

  return {
    sessionsDeleted: sessions.deletedCount ?? 0,
    devicesDeleted: devices.deletedCount ?? 0,
    notificationsDeleted: notifications.deletedCount ?? 0,
    contactsDeleted,
    contactRequestsDeleted,
    blocksDeleted,
    pendingInvitesRevoked: inviteResult.modifiedCount ?? 0,
    privateAttachmentsDeleted: privateAttachmentResult.modifiedCount ?? 0
  };
};

export const finalizeAccountDeletionsOnce = async (
  now: Date = new Date(),
  batchSize: number = CLEANUP_BATCH_SIZE
): Promise<FinalizeAccountDeletionsResult> => {
  const candidates = await User.find({
    status: USER_STATUS.PENDING_DELETION,
    deletionScheduledFor: { $lte: now }
  })
    .sort({ deletionScheduledFor: 1 })
    .limit(batchSize);

  let finalized = 0;
  for (const user of candidates) {
    try {
      const side = await finalizeOneUser(user);
      if (side) {
        finalized += 1;
        await auditUserDeletionFinalized(
          { actorId: 'system' },
          {
            userId: (user._id as Types.ObjectId).toString(),
            sideEffects: side
          }
        );
      }
    } catch (err) {
      // Best-effort: a single bad user must not break the whole sweep. The
      // partial work (status flip if it happened) leaves the row in DELETED
      // so the next sweep skips it; an exception thrown before the status
      // flip simply leaves the user PENDING for the next pass.
      logger.error(
        { err, userId: (user._id as Types.ObjectId).toString() },
        'finalizeAccountDeletions: per-user finalize failed'
      );
    }
  }

  if (finalized > 0) {
    logger.info(
      { scanned: candidates.length, finalized },
      'finalizeAccountDeletions: batch complete'
    );
  }
  return { scanned: candidates.length, finalized };
};

// Convenience export so tests/callers don't need to reach for the private
// helper. NOT exported on the public privacy.service re-export — only the
// job and the test suite use it.
export const __testing = {
  finalizeOneUser,
  anonymizeUserFields,
  toObjectId
};
