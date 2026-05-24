import request from 'supertest';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import {
  ROLES,
  type Permission,
  type Role
} from '../permissions/permissions.constants';
import { REPORT_STATUS, REPORT_TARGET_TYPE } from '../moderation/report.types';
import { Notification } from './notification.model';
import { NotificationPreference } from './notificationPreference.model';
import { NOTIFICATION_TYPE } from './notification.types';

const app = buildApp();
const PASSWORD = 'correct horse battery';

const createUser = async (overrides: {
  email: string;
  displayName: string;
  role?: Role;
  customPermissions?: Permission[];
}) => {
  const hash = await argon2.hash(PASSWORD);
  return User.create({
    email: overrides.email,
    passwordHash: hash,
    displayName: overrides.displayName,
    role: overrides.role ?? ROLES.MEMBER,
    customPermissions: overrides.customPermissions ?? []
  });
};

const login = async (email: string): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD });
  return res.body.data.tokens.accessToken as string;
};

interface Seeded {
  id: string;
  email: string;
  token: string;
}

const seedUser = async (
  email: string,
  displayName: string,
  role?: Role,
  customPermissions?: Permission[]
): Promise<Seeded> => {
  const u = await createUser({ email, displayName, role, customPermissions });
  const token = await login(email);
  return { id: u._id.toString(), email, token };
};

const createDirect = async (a: Seeded, b: Seeded) => {
  const res = await request(app)
    .post('/api/v1/conversations/direct')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ participantId: b.id });
  return res.body.data.conversation.id as string;
};

const createGroup = async (
  owner: Seeded,
  memberIds: string[],
  title = 'Team'
) => {
  const res = await request(app)
    .post('/api/v1/conversations/groups')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ title, memberIds });
  return res.body.data.conversation.id as string;
};

const sendMessage = async (
  actor: Seeded,
  conversationId: string,
  text: string
) =>
  request(app)
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${actor.token}`)
    .send({ text });

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
// Notification creation via message send
// ---------------------------------------------------------------------------

describe('messages create notifications for other members', () => {
  it('does not create a notification for the sender', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await sendMessage(alice, convId, 'hello');

    const aliceCount = await Notification.countDocuments({ userId: alice.id });
    expect(aliceCount).toBe(0);
  });

  it('creates a notification for each other active member of a group', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');
    const convId = await createGroup(alice, [bob.id, carol.id], 'Project');

    await sendMessage(alice, convId, 'first post');

    const bobCount = await Notification.countDocuments({ userId: bob.id });
    const carolCount = await Notification.countDocuments({ userId: carol.id });
    expect(bobCount).toBe(1);
    expect(carolCount).toBe(1);

    const bobNotif = await Notification.findOne({ userId: bob.id });
    expect(bobNotif?.type).toBe(NOTIFICATION_TYPE.MESSAGE_RECEIVED);
    // Group title appears in the inbox title.
    expect(bobNotif?.title).toContain('Alice');
    expect(bobNotif?.title).toContain('Project');
    expect(bobNotif?.bodyPreview).toBe('first post');
  });
});

// ---------------------------------------------------------------------------
// Notification list endpoint — user scoping and read state
// ---------------------------------------------------------------------------

describe('GET /api/v1/notifications', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app).get('/api/v1/notifications');
    expect(res.status).toBe(401);
  });

  it('only returns the caller-owned notifications', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');
    const convId = await createGroup(alice, [bob.id, carol.id], 'Team');

    await sendMessage(alice, convId, 'hi all');

    const res = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].userId).toBe(bob.id);
    expect(res.body.data.unreadCount).toBe(1);

    // Carol gets her own; Alice gets none.
    const aliceRes = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(aliceRes.body.data.items).toHaveLength(0);
    expect(aliceRes.body.data.unreadCount).toBe(0);
  });

  it('supports unreadOnly filtering', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await sendMessage(alice, convId, 'one');
    await sendMessage(alice, convId, 'two');

    const list = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${bob.token}`);
    const firstId = list.body.data.items[0].id as string;

    await request(app)
      .patch(`/api/v1/notifications/${firstId}/read`)
      .set('Authorization', `Bearer ${bob.token}`);

    const unreadRes = await request(app)
      .get('/api/v1/notifications?unreadOnly=true')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(unreadRes.body.data.items).toHaveLength(1);
    expect(unreadRes.body.data.unreadCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Mark read authorization
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/notifications/:id/read', () => {
  it('returns 404 when marking another user notification (no leak)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createDirect(alice, bob);
    await sendMessage(alice, convId, 'private');

    const list = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${bob.token}`);
    const notifId = list.body.data.items[0].id as string;

    const res = await request(app)
      .patch(`/api/v1/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${eve.token}`);
    expect(res.status).toBe(404);

    // Confirm bob's notification is still unread.
    const stored = await Notification.findById(notifId);
    expect(stored?.readAt).toBeUndefined();
  });

  it('marks the caller-owned notification as read (idempotent)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);
    await sendMessage(alice, convId, 'hello');

    const list = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${bob.token}`);
    const notifId = list.body.data.items[0].id as string;

    const first = await request(app)
      .patch(`/api/v1/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(first.status).toBe(200);
    expect(first.body.data.notification.readAt).toBeTruthy();
    const firstReadAt = first.body.data.notification.readAt as string;

    const second = await request(app)
      .patch(`/api/v1/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(second.status).toBe(200);
    expect(second.body.data.notification.readAt).toBe(firstReadAt);
  });
});

describe('POST /api/v1/notifications/read-all', () => {
  it('marks all caller-owned notifications as read', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);
    await sendMessage(alice, convId, 'one');
    await sendMessage(alice, convId, 'two');
    await sendMessage(alice, convId, 'three');

    const res = await request(app)
      .post('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(3);

    const list = await request(app)
      .get('/api/v1/notifications?unreadOnly=true')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(list.body.data.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

describe('notification preferences', () => {
  it('returns defaults on first read and persists updates', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');

    const initial = await request(app)
      .get('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(initial.status).toBe(200);
    expect(initial.body.data.preferences).toEqual({
      pushEnabled: true,
      emailEnabled: false,
      messagePreviewEnabled: true,
      mutedConversationIds: []
    });

    const update = await request(app)
      .patch('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        pushEnabled: false,
        messagePreviewEnabled: false
      });
    expect(update.status).toBe(200);
    expect(update.body.data.preferences.pushEnabled).toBe(false);
    expect(update.body.data.preferences.messagePreviewEnabled).toBe(false);

    const reread = await request(app)
      .get('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(reread.body.data.preferences.pushEnabled).toBe(false);
  });

  it('rejects unknown fields (mass assignment guard)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .patch('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userId: new mongoose.Types.ObjectId().toString() });
    expect(res.status).toBe(400);
  });

  it('rejects an empty patch body', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .patch('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('muted conversations still write inbox rows but suppress push', async () => {
    // The push job is a placeholder log; we assert the inbox-write behavior
    // because that is what is observable across the public API.
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await request(app)
      .patch('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ mutedConversationIds: [convId] });

    await sendMessage(alice, convId, 'hello');

    const list = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(list.body.data.items).toHaveLength(1);

    const storedPrefs = await NotificationPreference.findOne({
      userId: bob.id
    });
    expect(storedPrefs?.mutedConversationIds.map((id) => id.toString())).toEqual([
      convId
    ]);
  });
});

// ---------------------------------------------------------------------------
// Report status change notification
// ---------------------------------------------------------------------------

describe('report status changes notify the reporter', () => {
  it('creates a notification for the reporter when status changes', async () => {
    await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        targetType: REPORT_TARGET_TYPE.USER,
        targetId: bob.id,
        reason: 'spam'
      });
    const reportId = created.body.data.report.id;

    const modToken = await login('mod@example.com');
    await request(app)
      .patch(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ status: REPORT_STATUS.RESOLVED });

    const aliceNotifs = await Notification.find({ userId: alice.id });
    expect(aliceNotifs).toHaveLength(1);
    expect(aliceNotifs[0].type).toBe(NOTIFICATION_TYPE.REPORT_STATUS_CHANGED);
    expect(aliceNotifs[0].title).toContain('resolved');
  });
});
