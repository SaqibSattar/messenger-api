import request from 'supertest';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { Conversation } from '../conversations/conversation.model';
import { Message } from './message.model';
import { MessageReaction } from './messageReaction.model';
import { MessageReceipt } from './messageReceipt.model';
import {
  realtimeEvents,
  type RealtimeEventName
} from '../../services/realtimeEvents';

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

const createGroup = async (
  owner: SeededUser,
  memberIds: string[],
  title = 'Team'
) => {
  const res = await request(app)
    .post('/api/v1/conversations/groups')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ title, memberIds });
  return res.body.data.conversation.id as string;
};

const createDirect = async (a: SeededUser, b: SeededUser) => {
  const res = await request(app)
    .post('/api/v1/conversations/direct')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ participantId: b.id });
  return res.body.data.conversation.id as string;
};

const sendMessage = async (
  actor: SeededUser,
  conversationId: string,
  text: string,
  extra?: Record<string, unknown>
) =>
  request(app)
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${actor.token}`)
    .send({ text, ...(extra ?? {}) });

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
  realtimeEvents.removeAllListeners();
});

describe('POST /api/v1/conversations/:id/messages', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .post(
        `/api/v1/conversations/${new mongoose.Types.ObjectId().toString()}/messages`
      )
      .send({ text: 'hi' });
    expect(res.status).toBe(401);
  });

  it('lets a member send a text message and updates the conversation preview', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const res = await sendMessage(alice, convId, 'hello world');
    expect(res.status).toBe(201);
    expect(res.body.data.message.text).toBe('hello world');
    expect(res.body.data.message.senderId).toBe(alice.id);
    expect(res.body.data.message.conversationId).toBe(convId);

    const conv = await Conversation.findById(convId);
    expect(conv?.lastMessage?.preview).toBe('hello world');
    expect(conv?.lastMessage?.messageId.toString()).toBe(
      res.body.data.message.id
    );
  });

  it('rejects sending to a conversation you do not belong to (404)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(alice, [bob.id]);

    const res = await sendMessage(eve, convId, 'sneak attack');
    expect(res.status).toBe(404);

    const msgs = await Message.find({ conversationId: convId });
    expect(msgs).toHaveLength(0);
  });

  it('rejects empty text', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const empty = await sendMessage(alice, convId, '');
    expect(empty.status).toBe(400);

    const whitespace = await sendMessage(alice, convId, '   \n   ');
    expect(whitespace.status).toBe(400);
  });

  it('strips invisible/control characters from text', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const res = await sendMessage(alice, convId, 'Hi​‮ there');
    expect(res.status).toBe(201);
    expect(res.body.data.message.text).toBe('Hi there');
  });

  it('rejects oversized text', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const oversized = 'a'.repeat(4001);
    const res = await sendMessage(alice, convId, oversized);
    expect(res.status).toBe(400);
  });

  it('rejects unknown fields (mass-assignment guard)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'hi', senderId: bob.id, deletedAt: new Date() });
    expect(res.status).toBe(400);
  });

  it('honours whoCanSendMessages=admins', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    // Lock to admins-only.
    await request(app)
      .patch(`/api/v1/conversations/${convId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ settings: { whoCanSendMessages: 'admins' } });

    const bobSend = await sendMessage(bob, convId, 'me too');
    expect(bobSend.status).toBe(403);

    const aliceSend = await sendMessage(alice, convId, 'owner here');
    expect(aliceSend.status).toBe(201);
  });

  it('supports reply-to in the same conversation', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const first = await sendMessage(alice, convId, 'parent');
    const reply = await sendMessage(bob, convId, 'child', {
      replyToMessageId: first.body.data.message.id
    });
    expect(reply.status).toBe(201);
    expect(reply.body.data.message.replyToMessageId).toBe(
      first.body.data.message.id
    );
  });

  it('rejects reply-to from a different conversation', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const conv1 = await createGroup(alice, [bob.id], 'one');
    const conv2 = await createGroup(alice, [bob.id], 'two');

    const inConv1 = await sendMessage(alice, conv1, 'parent');

    const cross = await sendMessage(alice, conv2, 'child', {
      replyToMessageId: inConv1.body.data.message.id
    });
    expect(cross.status).toBe(400);
  });

  it('emits message.created on the realtime bus', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const events: Array<{ event: RealtimeEventName; payload: unknown }> = [];
    realtimeEvents.on('message.created', (payload) =>
      events.push({ event: 'message.created', payload })
    );

    const res = await sendMessage(alice, convId, 'broadcast me');
    expect(res.status).toBe(201);
    expect(events).toHaveLength(1);
    const payload = events[0].payload as {
      conversationId: string;
      message: { id: string };
    };
    expect(payload.conversationId).toBe(convId);
    expect(payload.message.id).toBe(res.body.data.message.id);
  });
});

describe('GET /api/v1/conversations/:id/messages', () => {
  it('non-members cannot list (403 via membership assertion)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(alice, [bob.id]);
    await sendMessage(alice, convId, 'private');

    const res = await request(app)
      .get(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${eve.token}`);
    expect(res.status).toBe(403);
  });

  it('paginates newest-first with a cursor', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    // Five messages, alternating senders.
    const sent = [];
    for (let i = 0; i < 5; i++) {
      const r = await sendMessage(
        i % 2 === 0 ? alice : bob,
        convId,
        `msg ${i}`
      );
      sent.push(r.body.data.message.id);
    }

    const page1 = await request(app)
      .get(`/api/v1/conversations/${convId}/messages?limit=2`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.items[0].id).toBe(sent[4]);
    expect(page1.body.data.items[1].id).toBe(sent[3]);
    expect(page1.body.data.nextCursor).toBeTruthy();

    const page2 = await request(app)
      .get(
        `/api/v1/conversations/${convId}/messages?limit=2&cursor=${page1.body.data.nextCursor}`
      )
      .set('Authorization', `Bearer ${alice.token}`);
    expect(page2.body.data.items.map((m: { id: string }) => m.id)).toEqual([
      sent[2],
      sent[1]
    ]);
  });

  it('rejects out-of-range limits', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const res = await request(app)
      .get(`/api/v1/conversations/${convId}/messages?limit=9999`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(400);
  });

  it('platform moderators can list messages they did not send', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const convId = await createGroup(alice, [bob.id]);
    await sendMessage(alice, convId, 'visible to mod');

    const res = await request(app)
      .get(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${mod.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });
});

describe('GET /api/v1/messages/:id', () => {
  it('non-members cannot read a specific message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'hi');

    const res = await request(app)
      .get(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${eve.token}`);
    expect(res.status).toBe(403);
  });

  it('members can read', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'hi');

    const res = await request(app)
      .get(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.message.text).toBe('hi');
  });
});

describe('PATCH /api/v1/messages/:id', () => {
  it('only the sender can edit; others get 403', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'original');

    const bobEdit = await request(app)
      .patch(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ text: 'hijacked' });
    expect(bobEdit.status).toBe(403);

    const aliceEdit = await request(app)
      .patch(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'edited' });
    expect(aliceEdit.status).toBe(200);
    expect(aliceEdit.body.data.message.text).toBe('edited');
    expect(aliceEdit.body.data.message.editedAt).toBeTruthy();
  });

  it('cannot edit a deleted message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'original');

    await request(app)
      .delete(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${alice.token}`);

    const res = await request(app)
      .patch(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'revived' });
    expect(res.status).toBe(404);
  });

  it('a sender who has left the conversation cannot edit their old message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(bob, convId, 'before leaving');

    const leave = await request(app)
      .post(`/api/v1/conversations/${convId}/leave`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(leave.status).toBe(200);

    const res = await request(app)
      .patch(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ text: 'sneaky edit' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/messages/:id', () => {
  it('sender can soft-delete; deleted message text is hidden from clients', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'oops');

    const del = await request(app)
      .delete(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(del.status).toBe(200);
    expect(del.body.data.message.text).toBeNull();
    expect(del.body.data.message.deletedAt).toBeTruthy();

    // Original body still in DB for audit but not returned.
    const dbDoc = await Message.findById(sent.body.data.message.id);
    expect(dbDoc?.text).toBe('oops');
    expect(dbDoc?.deletedAt).toBeInstanceOf(Date);

    // Re-fetch via API for any member: text still hidden.
    const fetched = await request(app)
      .get(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(fetched.body.data.message.text).toBeNull();
  });

  it('non-sender (non-mod) cannot delete', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'theirs');

    const res = await request(app)
      .delete(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(403);
  });

  it('platform moderator can delete other users messages and reason is recorded', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'abusive');

    const res = await request(app)
      .delete(`/api/v1/messages/${sent.body.data.message.id}`)
      .set('Authorization', `Bearer ${mod.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.message.deletionReason).toBe('moderator_deleted');
    expect(res.body.data.message.deletedBy).toBe(mod.id);
  });
});

describe('Reactions', () => {
  it('member can add and remove their own reaction', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'react to me');

    const add = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/reactions`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ emoji: '👍' });
    expect(add.status).toBe(201);
    expect(add.body.data.reaction.emoji).toBe('👍');

    const remove = await request(app)
      .delete(
        `/api/v1/messages/${sent.body.data.message.id}/reactions/${add.body.data.reaction.id}`
      )
      .set('Authorization', `Bearer ${bob.token}`);
    expect(remove.status).toBe(200);

    const remaining = await MessageReaction.find({});
    expect(remaining).toHaveLength(0);
  });

  it('duplicate same-emoji reaction is idempotent (returns existing)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'react to me');

    const first = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/reactions`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ emoji: '👍' });
    const second = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/reactions`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ emoji: '👍' });

    expect(first.body.data.reaction.id).toBe(second.body.data.reaction.id);
    const all = await MessageReaction.find({});
    expect(all).toHaveLength(1);
  });

  it('non-members cannot react', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'react to me');

    const res = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/reactions`)
      .set('Authorization', `Bearer ${eve.token}`)
      .send({ emoji: '👍' });
    expect(res.status).toBe(404);
  });

  it('rejects ASCII-text "reactions"', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const sent = await sendMessage(alice, convId, 'react');

    const res = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/reactions`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ emoji: 'lol' });
    expect(res.status).toBe(400);
  });

  it('cannot remove another user’s reaction', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');
    const convId = await createGroup(alice, [bob.id, carol.id]);
    const sent = await sendMessage(alice, convId, 'react');

    const bobReact = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/reactions`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ emoji: '👍' });

    const carolRemove = await request(app)
      .delete(
        `/api/v1/messages/${sent.body.data.message.id}/reactions/${bobReact.body.data.reaction.id}`
      )
      .set('Authorization', `Bearer ${carol.token}`);
    expect(carolRemove.status).toBe(403);
  });
});

describe('Receipts', () => {
  it('marks delivered and read; sender cannot receipt own message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);
    const sent = await sendMessage(alice, convId, 'sup');

    // Sender cannot receipt their own message.
    const ownDelivery = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/delivered`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(ownDelivery.status).toBe(400);

    const bobDelivered = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/delivered`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(bobDelivered.status).toBe(200);
    expect(bobDelivered.body.data.receipt.deliveredAt).toBeTruthy();
    expect(bobDelivered.body.data.receipt.readAt).toBeFalsy();

    const bobRead = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/read`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(bobRead.status).toBe(200);
    expect(bobRead.body.data.receipt.readAt).toBeTruthy();
    // Same receipt document, not a duplicate.
    expect(bobRead.body.data.receipt.id).toBe(bobDelivered.body.data.receipt.id);

    const receipts = await MessageReceipt.find({});
    expect(receipts).toHaveLength(1);
  });

  it('non-members cannot mark a message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createDirect(alice, bob);
    const sent = await sendMessage(alice, convId, 'private');

    const res = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/read`)
      .set('Authorization', `Bearer ${eve.token}`);
    expect(res.status).toBe(404);
  });

  it('emits message.read after a read receipt', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);
    const sent = await sendMessage(alice, convId, 'sup');

    const events: unknown[] = [];
    realtimeEvents.on('message.read', (p) => events.push(p));

    const res = await request(app)
      .post(`/api/v1/messages/${sent.body.data.message.id}/read`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
  });
});

describe('Validation', () => {
  it('rejects malformed conversation id on send', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post(`/api/v1/conversations/not-an-id/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed message id on edit', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .patch(`/api/v1/messages/not-an-id`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'hi' });
    expect(res.status).toBe(400);
  });
});
