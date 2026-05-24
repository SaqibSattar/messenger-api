import request from 'supertest';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { ConversationMember } from '../conversations/conversationMember.model';
import { InviteLink } from './inviteLink.model';

const app = buildApp();
const PASSWORD = 'correct horse battery';

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
  role?: Role
): Promise<Seeded> => {
  const u = await createUser({ email, displayName, role });
  const token = await login(email);
  return { id: u._id.toString(), email, token };
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

const createDirect = async (a: Seeded, b: Seeded) => {
  const res = await request(app)
    .post('/api/v1/conversations/direct')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ participantId: b.id });
  return res.body.data.conversation.id as string;
};

const createInvite = (actor: Seeded, conversationId: string, body?: object) =>
  request(app)
    .post(`/api/v1/conversations/${conversationId}/invites`)
    .set('Authorization', `Bearer ${actor.token}`)
    .send(body ?? {});

const joinByToken = (actor: Seeded, token: string) =>
  request(app)
    .post(`/api/v1/invites/${token}/join`)
    .set('Authorization', `Bearer ${actor.token}`);

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
// Create
// ---------------------------------------------------------------------------

describe('POST /api/v1/conversations/:conversationId/invites', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .post(
        `/api/v1/conversations/${new mongoose.Types.ObjectId().toString()}/invites`
      )
      .send({});
    expect(res.status).toBe(401);
  });

  it('rejects non-admin members', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(owner, [bob.id]);
    const res = await createInvite(bob, convId);
    expect(res.status).toBe(403);
  });

  it('rejects creation for a direct conversation', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const direct = await createDirect(alice, bob);
    const res = await createInvite(alice, direct);
    expect(res.status).toBe(400);
  });

  it('creates an invite, returns the raw token only on creation, and stores only the hash', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(owner, [bob.id]);

    const res = await createInvite(owner, convId, { maxUses: 5 });
    expect(res.status).toBe(201);
    expect(res.body.data.invite.token).toBeTruthy();
    expect(typeof res.body.data.invite.token).toBe('string');
    expect(res.body.data.invite.token.length).toBeGreaterThanOrEqual(16);
    expect(res.body.data.invite.useCount).toBe(0);
    expect(res.body.data.invite.maxUses).toBe(5);

    const stored = await InviteLink.findById(res.body.data.invite.id);
    expect(stored).not.toBeNull();
    // tokenHash is not the raw token.
    expect(stored?.tokenHash).not.toBe(res.body.data.invite.token);
    expect(stored?.tokenHash.length).toBe(64); // hex SHA-256

    // List does not re-emit the token.
    const list = await request(app)
      .get(`/api/v1/conversations/${convId}/invites`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items[0].token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

describe('POST /api/v1/invites/:token/join', () => {
  it('lets a new user join via the token', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(owner, [bob.id]);
    const created = await createInvite(owner, convId);
    const token = created.body.data.invite.token;

    const res = await joinByToken(eve, token);
    expect(res.status).toBe(200);
    expect(res.body.data.conversationId).toBe(convId);

    const member = await ConversationMember.findOne({
      conversationId: convId,
      userId: eve.id
    });
    expect(member).not.toBeNull();

    // useCount should increment.
    const stored = await InviteLink.findById(created.body.data.invite.id);
    expect(stored?.useCount).toBe(1);
  });

  it('rejects an unknown token with a generic not-found', async () => {
    const eve = await seedUser('eve@example.com', 'Eve');
    const res = await joinByToken(eve, 'AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(res.status).toBe(404);
  });

  it('rejects an expired invite', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(owner, [bob.id]);
    const created = await createInvite(owner, convId);
    const token = created.body.data.invite.token;

    // Backdate the expiry so the join path sees it as already expired.
    await InviteLink.updateOne(
      { _id: created.body.data.invite.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const res = await joinByToken(eve, token);
    expect(res.status).toBe(404);
    // Useful negative check: no membership was created.
    const member = await ConversationMember.findOne({
      conversationId: convId,
      userId: eve.id
    });
    expect(member).toBeNull();
  });

  it('rejects a revoked invite', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(owner, [bob.id]);
    const created = await createInvite(owner, convId);
    const inviteId = created.body.data.invite.id;
    const token = created.body.data.invite.token;

    const rev = await request(app)
      .delete(`/api/v1/invites/${inviteId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(rev.status).toBe(200);

    const res = await joinByToken(eve, token);
    expect(res.status).toBe(404);
  });

  it('rejects an invite that has reached maxUses', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const dave = await seedUser('dave@example.com', 'Dave');
    const convId = await createGroup(owner, [bob.id]);
    const created = await createInvite(owner, convId, { maxUses: 1 });
    const token = created.body.data.invite.token;

    const firstJoin = await joinByToken(eve, token);
    expect(firstJoin.status).toBe(200);
    const secondJoin = await joinByToken(dave, token);
    expect(secondJoin.status).toBe(404);
  });

  it('rejects a join when the joiner is blocked by (or has blocked) the creator', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(owner, [bob.id]);
    const created = await createInvite(owner, convId);
    const token = created.body.data.invite.token;

    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ blockedUserId: eve.id });

    const res = await joinByToken(eve, token);
    expect(res.status).toBe(403);
  });

  it('treats a re-join by the same user as idempotent success', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(owner, [bob.id]);
    const created = await createInvite(owner, convId);
    const token = created.body.data.invite.token;

    const first = await joinByToken(eve, token);
    expect(first.status).toBe(200);
    const second = await joinByToken(eve, token);
    expect(second.status).toBe(200);

    // Second hit must NOT advance the use counter — Eve is already a member.
    const stored = await InviteLink.findById(created.body.data.invite.id);
    expect(stored?.useCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/invites/:inviteId', () => {
  it('rejects non-admin callers', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(owner, [bob.id]);
    const created = await createInvite(owner, convId);
    const res = await request(app)
      .delete(`/api/v1/invites/${created.body.data.invite.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(403);
  });

  it('is idempotent on already-revoked invites', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(owner, [bob.id]);
    const created = await createInvite(owner, convId);
    const inviteId = created.body.data.invite.id;

    const r1 = await request(app)
      .delete(`/api/v1/invites/${inviteId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .delete(`/api/v1/invites/${inviteId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(r2.status).toBe(200);
  });
});
