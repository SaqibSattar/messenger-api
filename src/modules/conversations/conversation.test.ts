import request from 'supertest';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { Conversation } from './conversation.model';
import { ConversationMember } from './conversationMember.model';
import {
  CONVERSATION_MEMBER_ROLE,
  CONVERSATION_TYPE
} from './conversation.types';

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

interface SeededUser {
  id: string;
  email: string;
  token: string;
}

const seedUser = async (
  email: string,
  displayName: string,
  role?: Role
): Promise<SeededUser> => {
  const user = await createUser({ email, displayName, role });
  const token = await login(email);
  return { id: user._id.toString(), email, token };
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

describe('POST /api/v1/conversations/direct', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .post('/api/v1/conversations/direct')
      .send({ participantId: new mongoose.Types.ObjectId().toString() });
    expect(res.status).toBe(401);
  });

  it('creates a direct conversation with both members and returns my membership', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const res = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });

    expect(res.status).toBe(201);
    expect(res.body.data.conversation.type).toBe(CONVERSATION_TYPE.DIRECT);
    expect(res.body.data.membership.userId).toBe(alice.id);
    expect(res.body.data.membership.role).toBe(
      CONVERSATION_MEMBER_ROLE.MEMBER
    );

    const convId = res.body.data.conversation.id;
    const members = await ConversationMember.find({ conversationId: convId });
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.userId.toString()).sort()).toEqual(
      [alice.id, bob.id].sort()
    );
  });

  it('deduplicates direct conversations between the same two users', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const first = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    expect(first.status).toBe(201);

    // Same direction
    const again = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    expect(again.status).toBe(201);
    expect(again.body.data.conversation.id).toBe(
      first.body.data.conversation.id
    );

    // Opposite direction
    const reverse = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ participantId: alice.id });
    expect(reverse.status).toBe(201);
    expect(reverse.body.data.conversation.id).toBe(
      first.body.data.conversation.id
    );

    const convs = await Conversation.find({ type: CONVERSATION_TYPE.DIRECT });
    expect(convs).toHaveLength(1);
  });

  it('rejects starting a conversation with yourself', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: alice.id });
    expect(res.status).toBe(400);
  });

  it('rejects starting a conversation with a non-existent user', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: new mongoose.Types.ObjectId().toString() });
    expect(res.status).toBe(400);
  });

  it('rejects malformed participant IDs', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: 'not-an-id' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/conversations/groups', () => {
  it('creates a group with the caller as owner and other members as members', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    const res = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        title: '  Project   Team  ',
        memberIds: [bob.id, carol.id]
      });

    expect(res.status).toBe(201);
    expect(res.body.data.conversation.type).toBe(CONVERSATION_TYPE.GROUP);
    // Title should be normalized (whitespace collapsed).
    expect(res.body.data.conversation.title).toBe('Project Team');
    expect(res.body.data.membership.role).toBe(
      CONVERSATION_MEMBER_ROLE.OWNER
    );

    const convId = res.body.data.conversation.id;
    const members = await ConversationMember.find({ conversationId: convId });
    expect(members).toHaveLength(3);
    expect(
      members.find((m) => m.userId.toString() === alice.id)?.role
    ).toBe(CONVERSATION_MEMBER_ROLE.OWNER);
    expect(
      members.find((m) => m.userId.toString() === bob.id)?.role
    ).toBe(CONVERSATION_MEMBER_ROLE.MEMBER);
  });

  it('requires a title and at least one other member', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');

    const noTitle = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [new mongoose.Types.ObjectId().toString()] });
    expect(noTitle.status).toBe(400);

    const noMembers = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Group', memberIds: [] });
    expect(noMembers.status).toBe(400);
  });

  it('drops duplicate ids and the caller from memberIds', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const res = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        title: 'Pair',
        memberIds: [bob.id, bob.id, alice.id]
      });
    expect(res.status).toBe(201);
    const members = await ConversationMember.find({
      conversationId: res.body.data.conversation.id
    });
    expect(members).toHaveLength(2);
  });

  it('rejects unknown member ids', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        title: 'Group',
        memberIds: [new mongoose.Types.ObjectId().toString()]
      });
    expect(res.status).toBe(400);
  });

  it('strips zero-width and bidi-override characters from the title', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const res = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        title: 'Admins‮​ Team',
        memberIds: [bob.id]
      });
    expect(res.status).toBe(201);
    expect(res.body.data.conversation.title).toBe('Admins Team');
  });
});

describe('GET /api/v1/conversations', () => {
  it('lists only my conversations and supports cursor pagination', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    // alice is in 3 groups
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post('/api/v1/conversations/groups')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ title: `Group ${i}`, memberIds: [bob.id] });
      expect(r.status).toBe(201);
    }
    // carol has her own group that alice should not see
    await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${carol.token}`)
      .send({ title: 'Carol only', memberIds: [bob.id] });

    const page1 = await request(app)
      .get('/api/v1/conversations?limit=2')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.nextCursor).toBeTruthy();
    for (const item of page1.body.data.items) {
      expect(item.membership.userId).toBe(alice.id);
    }

    const page2 = await request(app)
      .get(`/api/v1/conversations?limit=2&cursor=${page1.body.data.nextCursor}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(page2.status).toBe(200);
    expect(page2.body.data.items).toHaveLength(1);
    expect(page2.body.data.nextCursor).toBeNull();

    // Carol's group is invisible to alice.
    const all = [...page1.body.data.items, ...page2.body.data.items];
    for (const item of all) {
      expect(item.conversation.title).not.toBe('Carol only');
    }
  });

  it('excludes archived conversations by default and includes them when asked', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const groupRes = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Archived group', memberIds: [bob.id] });
    expect(groupRes.status).toBe(201);
    const convId = groupRes.body.data.conversation.id;

    const archive = await request(app)
      .patch(`/api/v1/conversations/${convId}/preferences`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ archived: true });
    expect(archive.status).toBe(200);

    const defaultList = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(defaultList.body.data.items).toHaveLength(0);

    const withArchived = await request(app)
      .get('/api/v1/conversations?includeArchived=true')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(withArchived.body.data.items).toHaveLength(1);
  });

  it('rejects out-of-range limits', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .get('/api/v1/conversations?limit=1000')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/conversations/:id', () => {
  it('non-members cannot see the conversation (returns 404)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Private', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const eveRead = await request(app)
      .get(`/api/v1/conversations/${convId}`)
      .set('Authorization', `Bearer ${eve.token}`);
    expect(eveRead.status).toBe(404);
  });

  it('members can read and see the member roster', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Open', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const bobRead = await request(app)
      .get(`/api/v1/conversations/${convId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(bobRead.status).toBe(200);
    expect(bobRead.body.data.members).toHaveLength(2);
    expect(bobRead.body.data.membership.userId).toBe(bob.id);
  });

  it('rejects malformed conversation ids', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .get('/api/v1/conversations/not-an-id')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(400);
  });

  it('platform moderators can read conversations they are not in', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const mod = await seedUser(
      'mod@example.com',
      'Mod',
      ROLES.MODERATOR
    );

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Open', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const res = await request(app)
      .get(`/api/v1/conversations/${convId}`)
      .set('Authorization', `Bearer ${mod.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.membership).toBeNull();
  });
});

describe('PATCH /api/v1/conversations/:id', () => {
  it('only admins/owners can update group settings; plain members get 403', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Settings', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const bobEdit = await request(app)
      .patch(`/api/v1/conversations/${convId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Hijacked' });
    expect(bobEdit.status).toBe(403);

    const aliceEdit = await request(app)
      .patch(`/api/v1/conversations/${convId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Renamed', settings: { whoCanSendMessages: 'admins' } });
    expect(aliceEdit.status).toBe(200);
    expect(aliceEdit.body.data.conversation.title).toBe('Renamed');
    expect(
      aliceEdit.body.data.conversation.settings.whoCanSendMessages
    ).toBe('admins');
  });

  it('direct conversations cannot be edited', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const direct = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    const convId = direct.body.data.conversation.id;

    const res = await request(app)
      .patch(`/api/v1/conversations/${convId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Nope' });
    expect(res.status).toBe(400);
  });

  it('rejects unknown fields (mass-assignment guard)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Original', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const res = await request(app)
      .patch(`/api/v1/conversations/${convId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ createdBy: bob.id, type: 'direct' });
    expect(res.status).toBe(400);
  });
});

describe('Member management', () => {
  it('admins can add and remove members; plain members cannot', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');
    const dan = await seedUser('dan@example.com', 'Dan');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    // Plain member bob cannot add.
    const bobAdd = await request(app)
      .post(`/api/v1/conversations/${convId}/members`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ userIds: [carol.id] });
    expect(bobAdd.status).toBe(403);

    // Owner alice can add.
    const aliceAdd = await request(app)
      .post(`/api/v1/conversations/${convId}/members`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userIds: [carol.id, dan.id] });
    expect(aliceAdd.status).toBe(200);
    expect(aliceAdd.body.data.added).toHaveLength(2);

    // Plain member bob cannot remove.
    const bobRemove = await request(app)
      .delete(`/api/v1/conversations/${convId}/members/${carol.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(bobRemove.status).toBe(403);

    // Owner alice can remove dan.
    const aliceRemove = await request(app)
      .delete(`/api/v1/conversations/${convId}/members/${dan.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(aliceRemove.status).toBe(200);

    const danMembership = await ConversationMember.findOne({
      conversationId: convId,
      userId: dan.id
    });
    expect(danMembership?.leftAt).toBeInstanceOf(Date);
  });

  it('cannot remove the owner via the members endpoint', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    // Promote bob to admin so he could otherwise remove members.
    await request(app)
      .patch(`/api/v1/conversations/${convId}/members/${bob.id}/role`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ role: CONVERSATION_MEMBER_ROLE.ADMIN });

    const res = await request(app)
      .delete(`/api/v1/conversations/${convId}/members/${alice.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(403);
  });

  it('cannot remove yourself via the members endpoint (use leave)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const res = await request(app)
      .delete(`/api/v1/conversations/${convId}/members/${alice.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(400);
  });

  it('re-adding a member who left clears their leftAt', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    // bob leaves
    const leaveRes = await request(app)
      .post(`/api/v1/conversations/${convId}/leave`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(leaveRes.status).toBe(200);

    // alice re-adds bob
    const readd = await request(app)
      .post(`/api/v1/conversations/${convId}/members`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userIds: [bob.id] });
    expect(readd.status).toBe(200);

    const after = await ConversationMember.findOne({
      conversationId: convId,
      userId: bob.id
    });
    expect(after?.leftAt).toBeUndefined();
  });
});

describe('Role updates', () => {
  it('plain members cannot change roles', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id, carol.id] });
    const convId = created.body.data.conversation.id;

    const res = await request(app)
      .patch(`/api/v1/conversations/${convId}/members/${carol.id}/role`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ role: CONVERSATION_MEMBER_ROLE.ADMIN });
    expect(res.status).toBe(403);
  });

  it('admins can promote members to admin but cannot transfer ownership', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id, carol.id] });
    const convId = created.body.data.conversation.id;

    // alice promotes bob to admin
    const promote = await request(app)
      .patch(`/api/v1/conversations/${convId}/members/${bob.id}/role`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ role: CONVERSATION_MEMBER_ROLE.ADMIN });
    expect(promote.status).toBe(200);

    // bob (admin) tries to transfer ownership to carol — forbidden, only owner can.
    const transferByAdmin = await request(app)
      .patch(`/api/v1/conversations/${convId}/members/${carol.id}/role`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ role: CONVERSATION_MEMBER_ROLE.OWNER });
    expect(transferByAdmin.status).toBe(403);
  });

  it('owner can transfer ownership, which demotes the previous owner to admin', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const transfer = await request(app)
      .patch(`/api/v1/conversations/${convId}/members/${bob.id}/role`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ role: CONVERSATION_MEMBER_ROLE.OWNER });
    expect(transfer.status).toBe(200);
    expect(transfer.body.data.member.role).toBe(
      CONVERSATION_MEMBER_ROLE.OWNER
    );

    const aliceMember = await ConversationMember.findOne({
      conversationId: convId,
      userId: alice.id
    });
    expect(aliceMember?.role).toBe(CONVERSATION_MEMBER_ROLE.ADMIN);
  });

  it('cannot demote the owner without transferring', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    // alice (owner) tries to demote herself directly via PATCH role — should fail
    // because the target is the owner.
    const res = await request(app)
      .patch(`/api/v1/conversations/${convId}/members/${alice.id}/role`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ role: CONVERSATION_MEMBER_ROLE.MEMBER });
    expect(res.status).toBe(400);
  });
});

describe('Leave conversation', () => {
  it('direct conversations cannot be left via /leave', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const direct = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    const convId = direct.body.data.conversation.id;

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/leave`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(400);
  });

  it('group owners must transfer ownership before leaving if others remain', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const blocked = await request(app)
      .post(`/api/v1/conversations/${convId}/leave`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(blocked.status).toBe(400);

    // Transfer to bob, then alice can leave.
    await request(app)
      .patch(`/api/v1/conversations/${convId}/members/${bob.id}/role`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ role: CONVERSATION_MEMBER_ROLE.OWNER });

    const ok = await request(app)
      .post(`/api/v1/conversations/${convId}/leave`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(ok.status).toBe(200);

    const aliceMember = await ConversationMember.findOne({
      conversationId: convId,
      userId: alice.id
    });
    expect(aliceMember?.leftAt).toBeInstanceOf(Date);
  });

  it('plain members can leave a group', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/leave`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);

    // bob can no longer read the conversation.
    const read = await request(app)
      .get(`/api/v1/conversations/${convId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(read.status).toBe(404);
  });
});

describe('Read pointer and preferences', () => {
  it('only members can update the read pointer', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;
    const fakeMessageId = new mongoose.Types.ObjectId().toString();

    const eveRes = await request(app)
      .patch(`/api/v1/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${eve.token}`)
      .send({ lastReadMessageId: fakeMessageId });
    expect(eveRes.status).toBe(404);

    const aliceRes = await request(app)
      .patch(`/api/v1/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ lastReadMessageId: fakeMessageId });
    expect(aliceRes.status).toBe(200);
    expect(aliceRes.body.data.membership.lastReadMessageId).toBe(
      fakeMessageId
    );
  });

  it('read pointer cannot move backwards', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const older = new mongoose.Types.ObjectId().toString();
    // Wait a tick so the new ObjectId is strictly greater.
    await new Promise((r) => setTimeout(r, 5));
    const newer = new mongoose.Types.ObjectId().toString();

    await request(app)
      .patch(`/api/v1/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ lastReadMessageId: newer });

    const back = await request(app)
      .patch(`/api/v1/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ lastReadMessageId: older });
    expect(back.status).toBe(200);
    expect(back.body.data.membership.lastReadMessageId).toBe(newer);
  });

  it('mute and archive can be set and cleared independently', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const setMute = await request(app)
      .patch(`/api/v1/conversations/${convId}/preferences`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ mutedUntil: future, archived: true });
    expect(setMute.status).toBe(200);
    expect(setMute.body.data.membership.mutedUntil).toBeTruthy();
    expect(setMute.body.data.membership.archivedAt).toBeTruthy();

    const clear = await request(app)
      .patch(`/api/v1/conversations/${convId}/preferences`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ mutedUntil: null, archived: false });
    expect(clear.status).toBe(200);
    expect(clear.body.data.membership.mutedUntil).toBeUndefined();
    expect(clear.body.data.membership.archivedAt).toBeUndefined();
  });

  it('rejects mutedUntil in the past', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await request(app)
      .patch(`/api/v1/conversations/${convId}/preferences`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ mutedUntil: past });
    expect(res.status).toBe(400);
  });

  it('rejects an empty preferences body', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await request(app)
      .post('/api/v1/conversations/groups')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Team', memberIds: [bob.id] });
    const convId = created.body.data.conversation.id;

    const res = await request(app)
      .patch(`/api/v1/conversations/${convId}/preferences`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
