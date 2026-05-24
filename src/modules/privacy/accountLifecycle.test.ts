import request from 'supertest';
import argon2 from 'argon2';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import {
  DELETED_USER_DISPLAY_NAME,
  USER_STATUS
} from '../users/user.types';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { Session } from '../sessions/session.model';
import { Device } from '../devices/device.model';
import { Notification } from '../notifications/notification.model';
import { Contact } from '../contacts/contact.model';
import { ContactRequest } from '../contacts/contactRequest.model';
import { Block } from '../moderation/block.model';
import { InviteLink } from '../invites/inviteLink.model';
import { Attachment } from '../media/attachment.model';
import { Conversation } from '../conversations/conversation.model';
import { ConversationMember } from '../conversations/conversationMember.model';
import { Message } from '../messages/message.model';
import {
  ATTACHMENT_STATUS,
  ATTACHMENT_VISIBILITY
} from '../media/media.types';
import { finalizeAccountDeletionsOnce } from './accountLifecycle.service';
import { ACCOUNT_DELETION_GRACE_SECONDS } from './privacy.types';
import {
  CONVERSATION_MEMBER_ROLE,
  CONVERSATION_TYPE
} from '../conversations/conversation.types';
import { cleanupNotificationsOnce } from '../../jobs/cleanupNotifications';
import { cleanupInvitesOnce } from '../../jobs/cleanupInvites';
import { cleanupSessionsOnce } from '../../jobs/cleanupSessions';

const app = buildApp();
const PASSWORD = 'correct horse battery';

interface Seeded {
  id: string;
  email: string;
  token: string;
}

const createUser = async (overrides: {
  email: string;
  displayName: string;
  role?: Role;
}) => {
  const hash = await argon2.hash(PASSWORD);
  return User.create({
    email: overrides.email,
    passwordHash: hash,
    displayName: overrides.displayName,
    role: overrides.role ?? ROLES.MEMBER
  });
};

const login = async (email: string): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.tokens.accessToken as string;
};

const seedUser = async (
  email: string,
  displayName: string,
  role?: Role
): Promise<Seeded> => {
  const u = await createUser({ email, displayName, role });
  const token = await login(email);
  return { id: u._id.toString(), email, token };
};

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

// ---------------------------------------------------------------------------
// /me/delete-request
// ---------------------------------------------------------------------------

describe('POST /api/v1/users/me/delete-request', () => {
  it('rejects without the current password', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/users/me/delete-request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ password: 'wrong-password' });
    expect(res.status).toBe(401);

    const u = await User.findById(alice.id);
    expect(u?.status).toBe(USER_STATUS.ACTIVE);
    expect(u?.deletionScheduledFor).toBeUndefined();
  });

  it('flips the user to pending_deletion, revokes sessions, and revokes devices', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    // Pre-register a device so we can confirm the revoke side-effect.
    const reg = await request(app)
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        platform: 'ios',
        pushProvider: 'apns',
        pushToken: 'a'.repeat(64),
        deviceName: 'iPhone'
      });
    expect(reg.status).toBe(201);

    const res = await request(app)
      .post('/api/v1/users/me/delete-request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.deletion.state).toBe('pending');
    expect(typeof res.body.data.deletion.scheduledFor).toBe('string');

    const u = await User.findById(alice.id);
    expect(u?.status).toBe(USER_STATUS.PENDING_DELETION);
    expect(u?.deletionRequestedAt).toBeInstanceOf(Date);
    expect(u?.deletionScheduledFor).toBeInstanceOf(Date);
    expect(
      (u?.deletionScheduledFor?.getTime() ?? 0) - Date.now()
    ).toBeGreaterThan((ACCOUNT_DELETION_GRACE_SECONDS - 60) * 1000);

    // Pending-deletion accounts are still allowed by the auth middleware so
    // the user can reach /me/delete-cancel and /me/data-export during the
    // grace window — the access token only stops working once the user is
    // FINALIZED (DELETED status) or once the token's natural TTL expires.
    // What the request DOES revoke immediately is every refresh session and
    // every push device:
    const activeSessions = await Session.countDocuments({
      userId: u?._id,
      revokedAt: { $exists: false }
    });
    expect(activeSessions).toBe(0);
    // Trying to rotate via the original session's refresh token must 401.
    const stale = await Session.findOne({ userId: u?._id });
    expect(stale?.revokedReason).toBe('deletion_request');

    const activeDevices = await Device.countDocuments({
      userId: u?._id,
      revokedAt: { $exists: false }
    });
    expect(activeDevices).toBe(0);
  });

  it('is idempotent — re-requesting from pending_deletion returns the existing schedule', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    await request(app)
      .post('/api/v1/users/me/delete-request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ password: PASSWORD });

    // Re-login (the first request revoked the original session).
    const freshToken = await login(alice.email);
    const u1 = await User.findById(alice.id);
    const originalScheduled = u1?.deletionScheduledFor?.toISOString();

    const res = await request(app)
      .post('/api/v1/users/me/delete-request')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.deletion.scheduledFor).toBe(originalScheduled);

    const u2 = await User.findById(alice.id);
    expect(u2?.deletionScheduledFor?.toISOString()).toBe(originalScheduled);
  });
});

// ---------------------------------------------------------------------------
// /me/delete-cancel
// ---------------------------------------------------------------------------

describe('POST /api/v1/users/me/delete-cancel', () => {
  it('restores ACTIVE and clears the deletion fields', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    await request(app)
      .post('/api/v1/users/me/delete-request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ password: PASSWORD });

    // Re-login because the request revoked the original session.
    const freshToken = await login(alice.email);

    const cancel = await request(app)
      .post('/api/v1/users/me/delete-cancel')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.deletion.state).toBe('none');

    const u = await User.findById(alice.id);
    expect(u?.status).toBe(USER_STATUS.ACTIVE);
    expect(u?.deletionRequestedAt).toBeUndefined();
    expect(u?.deletionScheduledFor).toBeUndefined();
  });

  it('rejects a cancel when the account is not pending deletion', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/users/me/delete-cancel')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// /me/data-export
// ---------------------------------------------------------------------------

describe('GET /api/v1/users/me/data-export', () => {
  it('returns the export envelope and never includes secrets / tokens', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    await request(app)
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        platform: 'ios',
        pushProvider: 'apns',
        pushToken: 'export-token-' + 'x'.repeat(50),
        deviceName: 'iPhone'
      });

    const res = await request(app)
      .get('/api/v1/users/me/data-export')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);

    const dump = res.body.data;
    expect(dump.schemaVersion).toBe(1);
    expect(dump.user.id).toBe(alice.id);
    expect(dump.user.email).toBe(alice.email);
    // Never echo password material.
    expect(dump.user.passwordHash).toBeUndefined();
    // Devices have no pushToken.
    expect(dump.devices).toHaveLength(1);
    expect(dump.devices[0].pushToken).toBeUndefined();
    // Sessions have no refresh hash.
    expect(Array.isArray(dump.sessions)).toBe(true);
    for (const s of dump.sessions) {
      expect(s.refreshTokenHash).toBeUndefined();
    }
    // Defensive sweep: nothing anywhere in the envelope should look like a
    // hash / token / secret field.
    const json = JSON.stringify(dump);
    expect(json).not.toMatch(/refreshTokenHash/);
    expect(json).not.toMatch(/passwordHash/);
    expect(json).not.toMatch(/pushToken/);
    // The push token registered earlier must not appear in the export body.
    expect(json).not.toContain('export-token-');
  });
});

// ---------------------------------------------------------------------------
// finalizeAccountDeletionsOnce — anonymization + cascading cleanup
// ---------------------------------------------------------------------------

describe('finalizeAccountDeletionsOnce', () => {
  const setupAliceWithDeletionDue = async (): Promise<{
    aliceId: string;
    aliceToken: string;
  }> => {
    const alice = await seedUser('alice@example.com', 'Alice');
    await request(app)
      .post('/api/v1/users/me/delete-request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ password: PASSWORD });
    // Force the schedule into the past so the next finalize tick picks her up.
    await User.updateOne(
      { _id: alice.id },
      { $set: { deletionScheduledFor: new Date(Date.now() - 60_000) } }
    );
    return { aliceId: alice.id, aliceToken: alice.token };
  };

  it('anonymizes the user document and flips status to DELETED', async () => {
    const { aliceId } = await setupAliceWithDeletionDue();

    const result = await finalizeAccountDeletionsOnce();
    expect(result.finalized).toBe(1);

    const u = await User.findById(aliceId);
    expect(u?.status).toBe(USER_STATUS.DELETED);
    expect(u?.displayName).toBe(DELETED_USER_DISPLAY_NAME);
    expect(u?.email).toBeUndefined();
    expect(u?.phone).toBeUndefined();
    expect(u?.username).toBeUndefined();
    expect(u?.avatarUrl).toBeUndefined();
    expect(u?.bio).toBeUndefined();
    expect(u?.deletedAt).toBeInstanceOf(Date);
  });

  it('hides a deleted user from public profile lookups (404)', async () => {
    const { aliceId } = await setupAliceWithDeletionDue();
    await finalizeAccountDeletionsOnce();

    // A second user looks up Alice's public profile.
    const bob = await seedUser('bob@example.com', 'Bob');
    const res = await request(app)
      .get(`/api/v1/users/${aliceId}/public`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(404);
  });

  it('blocks login for the deleted user', async () => {
    await setupAliceWithDeletionDue();
    await finalizeAccountDeletionsOnce();

    // Original password no longer works — the user document was anonymized.
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('cleans up sessions, devices, notifications, contacts, blocks, pending invites, and private attachments', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    // Mutual contact: Alice ↔ Bob
    const contactReq = await request(app)
      .post('/api/v1/contacts/requests')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ receiverId: bob.id });
    expect(contactReq.status).toBe(201);
    await request(app)
      .post(`/api/v1/contacts/requests/${contactReq.body.data.request.id}/accept`)
      .set('Authorization', `Bearer ${bob.token}`);

    // Pending outgoing request: Alice → Carol (should be wiped).
    await request(app)
      .post('/api/v1/contacts/requests')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ receiverId: carol.id });

    // Alice blocks Carol (should be wiped).
    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userId: carol.id, reason: 'noise' });

    // A notification addressed to Alice.
    await Notification.create({
      userId: alice.id,
      type: 'message_received',
      title: 'Hello'
    });

    // Alice owns a private attachment that was never sent.
    await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        filename: 'note.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234
      });

    // Alice creates an invite link on a group she admins.
    const group = await Conversation.create({
      type: CONVERSATION_TYPE.GROUP,
      title: 'Alice group',
      createdBy: alice.id,
      settings: {
        whoCanSendMessages: 'all',
        disappearingMessages: { duration: 'off', durationSeconds: 0 }
      }
    });
    await ConversationMember.create({
      conversationId: group._id,
      userId: alice.id,
      role: CONVERSATION_MEMBER_ROLE.ADMIN
    });
    const inviteRes = await request(app)
      .post(`/api/v1/conversations/${group._id.toString()}/invites`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({});
    expect(inviteRes.status).toBe(201);
    const inviteId = inviteRes.body.data.invite.id as string;

    // Request deletion and force the schedule into the past.
    await request(app)
      .post('/api/v1/users/me/delete-request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ password: PASSWORD });
    await User.updateOne(
      { _id: alice.id },
      { $set: { deletionScheduledFor: new Date(Date.now() - 60_000) } }
    );

    const result = await finalizeAccountDeletionsOnce();
    expect(result.finalized).toBe(1);

    // Sessions / devices / notifications gone.
    expect(await Session.countDocuments({ userId: alice.id })).toBe(0);
    expect(await Device.countDocuments({ userId: alice.id })).toBe(0);
    expect(await Notification.countDocuments({ userId: alice.id })).toBe(0);

    // Contacts cleared in both directions.
    expect(
      await Contact.countDocuments({
        $or: [{ userId: alice.id }, { contactUserId: alice.id }]
      })
    ).toBe(0);

    // Pending contact requests cleared.
    expect(
      await ContactRequest.countDocuments({
        senderId: alice.id,
        status: 'pending'
      })
    ).toBe(0);

    // Blocks cleared.
    expect(
      await Block.countDocuments({
        $or: [{ blockerId: alice.id }, { blockedUserId: alice.id }]
      })
    ).toBe(0);

    // Pending invite is revoked but kept for audit.
    const invite = await InviteLink.findById(inviteId);
    expect(invite?.revokedAt).toBeInstanceOf(Date);

    // Private orphan attachment marked deleted.
    const attachments = await Attachment.find({
      ownerId: alice.id,
      visibility: ATTACHMENT_VISIBILITY.PRIVATE
    });
    expect(attachments.length).toBeGreaterThan(0);
    for (const a of attachments) {
      expect(a.status).toBe(ATTACHMENT_STATUS.DELETED);
    }
  });

  it('preserves messages in shared conversations so other participants still see history', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    // Direct conversation, Alice sends a message.
    const conv = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    expect(conv.status).toBe(201);
    const convId = conv.body.data.conversation.id as string;
    const sent = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'hello from Alice' });
    expect(sent.status).toBe(201);
    const messageId = sent.body.data.message.id as string;

    // Alice requests deletion, schedule pulled into the past, finalize.
    await request(app)
      .post('/api/v1/users/me/delete-request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ password: PASSWORD });
    await User.updateOne(
      { _id: alice.id },
      { $set: { deletionScheduledFor: new Date(Date.now() - 60_000) } }
    );
    await finalizeAccountDeletionsOnce();

    // Bob can still read the conversation list and the message text.
    const msg = await Message.findById(messageId);
    expect(msg).not.toBeNull();
    expect(msg?.text).toBe('hello from Alice');

    // Bob's view of the conversation still has both members logically; the
    // member rows are not deleted.
    const members = await ConversationMember.find({
      conversationId: conv.body.data.conversation.id
    });
    expect(members.length).toBe(2);
  });

  it('is idempotent — running the finalize sweep twice does not double-process', async () => {
    await setupAliceWithDeletionDue();
    const r1 = await finalizeAccountDeletionsOnce();
    const r2 = await finalizeAccountDeletionsOnce();
    expect(r1.finalized).toBe(1);
    expect(r2.scanned).toBe(0);
    expect(r2.finalized).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cleanup jobs idempotency
// ---------------------------------------------------------------------------

describe('cleanupNotificationsOnce', () => {
  it('removes notifications older than the retention window and is idempotent', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const old = await Notification.create({
      userId: alice.id,
      type: 'message_received',
      title: 'old'
    });
    // Use the underlying collection to bypass Mongoose's timestamp guard;
    // setting createdAt through the model is filtered out by the schema's
    // timestamps machinery.
    await Notification.collection.updateOne(
      { _id: old._id },
      { $set: { createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) } }
    );
    await Notification.create({
      userId: alice.id,
      type: 'message_received',
      title: 'recent'
    });

    const r1 = await cleanupNotificationsOnce(new Date());
    expect(r1.removed).toBe(1);
    const r2 = await cleanupNotificationsOnce(new Date());
    expect(r2.removed).toBe(0);
    expect(await Notification.countDocuments({ userId: alice.id })).toBe(1);
  });
});

describe('cleanupInvitesOnce', () => {
  it('removes revoked / expired invites older than retention and is idempotent', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const conv = await Conversation.create({
      type: CONVERSATION_TYPE.GROUP,
      title: 'Group',
      createdBy: alice.id,
      settings: {
        whoCanSendMessages: 'all',
        disappearingMessages: { duration: 'off', durationSeconds: 0 }
      }
    });
    const oldRevoked = await InviteLink.create({
      conversationId: conv._id,
      createdBy: alice.id,
      tokenHash: 'x'.repeat(64),
      revokedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      useCount: 0
    });
    const stillActive = await InviteLink.create({
      conversationId: conv._id,
      createdBy: alice.id,
      tokenHash: 'y'.repeat(64),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      useCount: 0
    });

    const r1 = await cleanupInvitesOnce(new Date());
    expect(r1.removed).toBe(1);
    expect(await InviteLink.findById(oldRevoked._id)).toBeNull();
    expect(await InviteLink.findById(stillActive._id)).not.toBeNull();

    const r2 = await cleanupInvitesOnce(new Date());
    expect(r2.removed).toBe(0);
  });
});

describe('cleanupSessionsOnce', () => {
  it('removes long-revoked sessions and leaves active ones alone', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const activeRow = await Session.findOne({ userId: alice.id });
    expect(activeRow).not.toBeNull();

    const oldRevoked = await Session.create({
      userId: alice.id,
      refreshTokenHash: 'oldhash' + 'z'.repeat(32),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      rotatedAt: new Date(),
      revokedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    });

    const r1 = await cleanupSessionsOnce(new Date());
    expect(r1.removed).toBe(1);
    expect(await Session.findById(oldRevoked._id)).toBeNull();
    expect(await Session.findById(activeRow?._id)).not.toBeNull();

    const r2 = await cleanupSessionsOnce(new Date());
    expect(r2.removed).toBe(0);
  });
});
