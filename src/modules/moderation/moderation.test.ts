import request from 'supertest';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import {
  PERMISSIONS,
  ROLES,
  type Permission,
  type Role
} from '../permissions/permissions.constants';
import { Conversation } from '../conversations/conversation.model';
import { Message } from '../messages/message.model';
import { Block } from './block.model';
import { Report } from './report.model';
import { ModerationAction } from './moderationAction.model';
import {
  REPORT_STATUS,
  REPORT_TARGET_TYPE
} from './report.types';
import {
  MODERATION_ACTION_TYPE,
  MODERATION_TARGET_TYPE
} from './moderation.types';

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
// Blocks
// ---------------------------------------------------------------------------

describe('POST /api/v1/blocks', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .post('/api/v1/blocks')
      .send({ blockedUserId: new mongoose.Types.ObjectId().toString() });
    expect(res.status).toBe(401);
  });

  it('rejects blocking yourself', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: alice.id });
    expect(res.status).toBe(400);
  });

  it('rejects blocking a non-existent user', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: new mongoose.Types.ObjectId().toString() });
    expect(res.status).toBe(404);
  });

  it('creates a block and is idempotent on retry', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const first = await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: bob.id, reason: 'spam' });
    expect(first.status).toBe(201);
    expect(first.body.data.block.blockerId).toBe(alice.id);
    expect(first.body.data.block.blockedUserId).toBe(bob.id);
    expect(first.body.data.block.reason).toBe('spam');

    const second = await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: bob.id });
    expect(second.status).toBe(201);
    expect(second.body.data.block.id).toBe(first.body.data.block.id);

    const count = await Block.countDocuments({
      blockerId: alice.id,
      blockedUserId: bob.id
    });
    expect(count).toBe(1);
  });
});

describe('GET /api/v1/blocks', () => {
  it('returns only the caller-owned blocks', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: bob.id });
    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: carol.id });
    // Bob also blocks Carol — should not leak into Alice's list.
    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ blockedUserId: carol.id });

    const res = await request(app)
      .get('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.items.map(
      (i: { blockedUser: { id: string } }) => i.blockedUser.id
    );
    expect(ids).toEqual(expect.arrayContaining([bob.id, carol.id]));
    expect(ids).toHaveLength(2);
    // Public DTO only — no sensitive fields leaked.
    const sample = res.body.data.items[0].blockedUser;
    expect(sample.email).toBeUndefined();
    expect(sample.role).toBeUndefined();
  });
});

describe('DELETE /api/v1/blocks/:blockedUserId', () => {
  it('removes the block', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: bob.id });

    const res = await request(app)
      .delete(`/api/v1/blocks/${bob.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);

    const count = await Block.countDocuments({
      blockerId: alice.id,
      blockedUserId: bob.id
    });
    expect(count).toBe(0);
  });

  it('returns 404 if no such block exists', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const res = await request(app)
      .delete(`/api/v1/blocks/${bob.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(404);
  });
});

describe('blocking gates direct messaging', () => {
  it('prevents creating a direct conversation when either side has blocked', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: bob.id });

    const aliceInit = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    expect(aliceInit.status).toBe(403);

    const bobInit = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ participantId: alice.id });
    expect(bobInit.status).toBe(403);
  });

  it('blocks sending to an existing direct conversation when a block exists', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: bob.id });

    const bobSend = await sendMessage(bob, convId, 'hi');
    expect(bobSend.status).toBe(403);
    const aliceSend = await sendMessage(alice, convId, 'hi');
    expect(aliceSend.status).toBe(403);
  });

  it('restores message sending after unblock', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: bob.id });
    const blocked = await sendMessage(alice, convId, 'hi');
    expect(blocked.status).toBe(403);

    await request(app)
      .delete(`/api/v1/blocks/${bob.id}`)
      .set('Authorization', `Bearer ${alice.token}`);

    const ok = await sendMessage(alice, convId, 'hi again');
    expect(ok.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe('POST /api/v1/reports', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app).post('/api/v1/reports').send({
      targetType: REPORT_TARGET_TYPE.USER,
      targetId: new mongoose.Types.ObjectId().toString(),
      reason: 'spam'
    });
    expect(res.status).toBe(401);
  });

  it('rejects reporting yourself (user target)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        targetType: REPORT_TARGET_TYPE.USER,
        targetId: alice.id,
        reason: 'spam'
      });
    expect(res.status).toBe(400);
  });

  it('rejects reporting your own message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'mine');

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        targetType: REPORT_TARGET_TYPE.MESSAGE,
        targetId: sent.body.data.message.id,
        reason: 'spam'
      });
    expect(res.status).toBe(400);
  });

  it('rejects reporting a message you cannot see (404 to avoid leakage)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'private');

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${eve.token}`)
      .send({
        targetType: REPORT_TARGET_TYPE.MESSAGE,
        targetId: sent.body.data.message.id,
        reason: 'harassment'
      });
    expect(res.status).toBe(404);
  });

  it('rejects reporting a conversation you were never part of', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(alice, [bob.id]);

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${eve.token}`)
      .send({
        targetType: REPORT_TARGET_TYPE.CONVERSATION,
        targetId: convId,
        reason: 'harassment'
      });
    expect(res.status).toBe(403);
  });

  it('creates an open report against a user and stores it', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        targetType: REPORT_TARGET_TYPE.USER,
        targetId: bob.id,
        reason: 'harassment',
        details: 'kept sending threats over DM'
      });
    expect(res.status).toBe(201);
    expect(res.body.data.report.status).toBe(REPORT_STATUS.OPEN);
    expect(res.body.data.report.reporterId).toBe(alice.id);
    expect(res.body.data.report.targetId).toBe(bob.id);
    expect(res.body.data.report.details).toBe('kept sending threats over DM');

    const stored = await Report.findById(res.body.data.report.id);
    expect(stored?.status).toBe(REPORT_STATUS.OPEN);
  });
});

describe('GET /api/v1/reports', () => {
  it('only returns the caller-owned reports for members', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ targetType: REPORT_TARGET_TYPE.USER, targetId: bob.id, reason: 'spam' });
    await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${carol.token}`)
      .send({ targetType: REPORT_TARGET_TYPE.USER, targetId: bob.id, reason: 'spam' });

    const res = await request(app)
      .get('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].reporterId).toBe(alice.id);
    // Listing masks the details body.
    expect(res.body.data.items[0].details).toBeUndefined();
  });

  it('returns the full queue for a reviewer (moderator)', async () => {
    await seedUser(
      'mod@example.com',
      'Mod',
      ROLES.MEMBER,
      [PERMISSIONS.REPORT_REVIEW, PERMISSIONS.REPORT_READ_OWN]
    );
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ targetType: REPORT_TARGET_TYPE.USER, targetId: bob.id, reason: 'spam' });
    await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${carol.token}`)
      .send({ targetType: REPORT_TARGET_TYPE.USER, targetId: bob.id, reason: 'spam' });

    const modToken = await login('mod@example.com');
    const res = await request(app)
      .get('/api/v1/reports')
      .set('Authorization', `Bearer ${modToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
  });
});

describe('GET /api/v1/reports/:reportId', () => {
  it('forbids viewing another user reports', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');

    const created = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        targetType: REPORT_TARGET_TYPE.USER,
        targetId: bob.id,
        reason: 'spam'
      });
    const reportId = created.body.data.report.id;

    const res = await request(app)
      .get(`/api/v1/reports/${reportId}`)
      .set('Authorization', `Bearer ${eve.token}`);
    expect(res.status).toBe(403);
  });

  it('lets the reporter view their own report including details', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        targetType: REPORT_TARGET_TYPE.USER,
        targetId: bob.id,
        reason: 'spam',
        details: 'context here'
      });
    const reportId = created.body.data.report.id;

    const res = await request(app)
      .get(`/api/v1/reports/${reportId}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.report.details).toBe('context here');
  });
});

describe('PATCH /api/v1/reports/:reportId/status', () => {
  it('rejects non-reviewers', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ targetType: REPORT_TARGET_TYPE.USER, targetId: bob.id, reason: 'spam' });
    const reportId = created.body.data.report.id;

    const res = await request(app)
      .patch(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ status: REPORT_STATUS.REVIEWING });
    expect(res.status).toBe(403);
  });

  it('reviewer can transition open -> reviewing -> resolved', async () => {
    await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ targetType: REPORT_TARGET_TYPE.USER, targetId: bob.id, reason: 'spam' });
    const reportId = created.body.data.report.id;

    const modToken = await login('mod@example.com');
    const r1 = await request(app)
      .patch(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ status: REPORT_STATUS.REVIEWING });
    expect(r1.status).toBe(200);
    expect(r1.body.data.report.status).toBe(REPORT_STATUS.REVIEWING);

    const r2 = await request(app)
      .patch(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ status: REPORT_STATUS.RESOLVED, note: 'handled' });
    expect(r2.status).toBe(200);
    expect(r2.body.data.report.status).toBe(REPORT_STATUS.RESOLVED);
    expect(r2.body.data.report.resolvedAt).toBeTruthy();
  });

  it('rejects illegal status transitions', async () => {
    await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ targetType: REPORT_TARGET_TYPE.USER, targetId: bob.id, reason: 'spam' });
    const reportId = created.body.data.report.id;

    const modToken = await login('mod@example.com');
    await request(app)
      .patch(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ status: REPORT_STATUS.RESOLVED });

    const reopen = await request(app)
      .patch(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ status: REPORT_STATUS.REVIEWING });
    expect(reopen.status).toBe(400);
  });

  it('blocks a moderator from reviewing their own report', async () => {
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${mod.token}`)
      .send({ targetType: REPORT_TARGET_TYPE.USER, targetId: bob.id, reason: 'spam' });
    const reportId = created.body.data.report.id;

    const res = await request(app)
      .patch(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${mod.token}`)
      .send({ status: REPORT_STATUS.REVIEWING });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Moderation actions
// ---------------------------------------------------------------------------

describe('POST /api/v1/moderation/actions', () => {
  it('rejects callers without moderation:action permission', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const res = await request(app)
      .post('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        actionType: MODERATION_ACTION_TYPE.WARN_USER,
        targetType: MODERATION_TARGET_TYPE.USER,
        targetId: bob.id,
        reason: 'be nicer'
      });
    expect(res.status).toBe(403);
  });

  it('rejects action/target type mismatches', async () => {
    await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const bob = await seedUser('bob@example.com', 'Bob');
    const modToken = await login('mod@example.com');

    const res = await request(app)
      .post('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${modToken}`)
      .send({
        actionType: MODERATION_ACTION_TYPE.DELETE_MESSAGE,
        targetType: MODERATION_TARGET_TYPE.USER,
        targetId: bob.id,
        reason: 'wrong target'
      });
    expect(res.status).toBe(400);
  });

  it('warns a user and writes an audited record (no state change)', async () => {
    await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const bob = await seedUser('bob@example.com', 'Bob');
    const modToken = await login('mod@example.com');

    const res = await request(app)
      .post('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${modToken}`)
      .send({
        actionType: MODERATION_ACTION_TYPE.WARN_USER,
        targetType: MODERATION_TARGET_TYPE.USER,
        targetId: bob.id,
        reason: 'first warning'
      });
    expect(res.status).toBe(201);
    expect(res.body.data.action.actionType).toBe(
      MODERATION_ACTION_TYPE.WARN_USER
    );

    const recorded = await ModerationAction.countDocuments({
      targetId: bob.id,
      actionType: MODERATION_ACTION_TYPE.WARN_USER
    });
    expect(recorded).toBe(1);

    const stillActive = await User.findById(bob.id);
    expect(stillActive?.status).toBe(USER_STATUS.ACTIVE);
  });

  it('suspends a user, revokes sessions, and records the action', async () => {
    await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const bob = await seedUser('bob@example.com', 'Bob');
    const modToken = await login('mod@example.com');

    const res = await request(app)
      .post('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${modToken}`)
      .send({
        actionType: MODERATION_ACTION_TYPE.SUSPEND_USER,
        targetType: MODERATION_TARGET_TYPE.USER,
        targetId: bob.id,
        reason: 'severe abuse'
      });
    expect(res.status).toBe(201);

    const updated = await User.findById(bob.id);
    expect(updated?.status).toBe(USER_STATUS.SUSPENDED);

    // Bob's old token must no longer work (suspended status fails requireAuth).
    const me = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(me.status).toBe(401);
  });

  it('rejects a moderator suspending themselves', async () => {
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const res = await request(app)
      .post('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${mod.token}`)
      .send({
        actionType: MODERATION_ACTION_TYPE.SUSPEND_USER,
        targetType: MODERATION_TARGET_TYPE.USER,
        targetId: mod.id,
        reason: 'oops'
      });
    expect(res.status).toBe(400);
  });

  it('deletes a message via moderation and the row reflects redaction', async () => {
    await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(bob, convId, 'rude content');
    const messageId = sent.body.data.message.id;

    const modToken = await login('mod@example.com');
    const res = await request(app)
      .post('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${modToken}`)
      .send({
        actionType: MODERATION_ACTION_TYPE.DELETE_MESSAGE,
        targetType: MODERATION_TARGET_TYPE.MESSAGE,
        targetId: messageId,
        reason: 'TOS violation'
      });
    expect(res.status).toBe(201);

    const stored = await Message.findById(messageId);
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.text).toBe('');
  });

  it('refuses to link an action to a report you authored', async () => {
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const bob = await seedUser('bob@example.com', 'Bob');

    const myReport = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${mod.token}`)
      .send({ targetType: REPORT_TARGET_TYPE.USER, targetId: bob.id, reason: 'spam' });

    const res = await request(app)
      .post('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${mod.token}`)
      .send({
        actionType: MODERATION_ACTION_TYPE.WARN_USER,
        targetType: MODERATION_TARGET_TYPE.USER,
        targetId: bob.id,
        reason: 'follow-up to my report',
        relatedReportId: myReport.body.data.report.id
      });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/moderation/actions', () => {
  it('rejects non-moderators', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .get('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(403);
  });

  it('lists recorded actions, newest first', async () => {
    await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const a = await seedUser('a@example.com', 'A');
    const b = await seedUser('b@example.com', 'B');
    const modToken = await login('mod@example.com');

    await request(app)
      .post('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${modToken}`)
      .send({
        actionType: MODERATION_ACTION_TYPE.WARN_USER,
        targetType: MODERATION_TARGET_TYPE.USER,
        targetId: a.id,
        reason: 'first'
      });
    await request(app)
      .post('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${modToken}`)
      .send({
        actionType: MODERATION_ACTION_TYPE.WARN_USER,
        targetType: MODERATION_TARGET_TYPE.USER,
        targetId: b.id,
        reason: 'second'
      });

    const res = await request(app)
      .get('/api/v1/moderation/actions')
      .set('Authorization', `Bearer ${modToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items[0].targetId).toBe(b.id);
  });
});

// Sanity: clearing the test DB drops everything, including the conversation
// the moderation flow depended on. This `expect` is here so a future change
// that accidentally drops the model file fails this test rather than silently
// passing the others.
test('Conversation model is registered', () => {
  expect(Conversation).toBeDefined();
});
