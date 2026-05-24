import request from 'supertest';
import argon2 from 'argon2';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { Conversation } from '../conversations/conversation.model';
import { Message } from './message.model';
import {
  realtimeEvents,
  type RealtimeEventName
} from '../../services/realtimeEvents';
import { expireMessagesOnce } from '../../jobs/expireMessages';

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

const setDisappearing = (
  actor: SeededUser,
  conversationId: string,
  duration: string
) =>
  request(app)
    .patch(`/api/v1/conversations/${conversationId}/disappearing-messages`)
    .set('Authorization', `Bearer ${actor.token}`)
    .send({ duration });

const sendMessage = (
  actor: SeededUser,
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
  realtimeEvents.removeAllListeners();
});

describe('PATCH /api/v1/conversations/:id/disappearing-messages', () => {
  it('rejects an unauthenticated caller', async () => {
    const res = await request(app)
      .patch(
        `/api/v1/conversations/507f1f77bcf86cd799439011/disappearing-messages`
      )
      .send({ duration: '24h' });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid duration', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    const res = await setDisappearing(alice, convId, '5m');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lets a direct chat participant enable disappearing messages', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    const res = await setDisappearing(alice, convId, '24h');
    expect(res.status).toBe(200);
    expect(res.body.data.conversation.settings.disappearingMessages.duration).toBe(
      '24h'
    );
    expect(
      res.body.data.conversation.settings.disappearingMessages.durationSeconds
    ).toBe(24 * 60 * 60);
    expect(
      res.body.data.conversation.settings.disappearingMessages.updatedBy
    ).toBe(alice.id);
  });

  it('rejects a non-member trying to change the setting', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createDirect(alice, bob);

    const res = await setDisappearing(eve, convId, '24h');
    // Non-members get 404 to avoid leaking conversation existence.
    expect(res.status).toBe(404);
  });

  it('rejects a non-admin group member', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(owner, [bob.id]);

    const res = await setDisappearing(bob, convId, '24h');
    expect(res.status).toBe(403);
  });

  it('lets the group owner change the setting', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(owner, [bob.id]);

    const res = await setDisappearing(owner, convId, '7d');
    expect(res.status).toBe(200);
    expect(res.body.data.conversation.settings.disappearingMessages.duration).toBe(
      '7d'
    );
  });

  it('a moderator cannot flip a group setting on a conversation they don\'t belong to', async () => {
    const owner = await seedUser('owner@example.com', 'Owner');
    const bob = await seedUser('bob@example.com', 'Bob');
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const convId = await createGroup(owner, [bob.id]);

    const res = await setDisappearing(mod, convId, '24h');
    expect(res.status).toBe(404);
  });

  it('emits a realtime event when the setting changes', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    const events: Array<{ event: RealtimeEventName; payload: unknown }> = [];
    realtimeEvents.on('conversation.disappearing_settings_updated', (p) =>
      events.push({ event: 'conversation.disappearing_settings_updated', payload: p })
    );

    const res = await setDisappearing(alice, convId, '24h');
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    const payload = events[0].payload as {
      conversationId: string;
      disappearingMessages: { duration: string };
    };
    expect(payload.conversationId).toBe(convId);
    expect(payload.disappearingMessages.duration).toBe('24h');
  });

  it('does not emit when the setting is unchanged', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');

    const events: unknown[] = [];
    realtimeEvents.on('conversation.disappearing_settings_updated', (p) =>
      events.push(p)
    );

    const res = await setDisappearing(alice, convId, '24h');
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });
});

describe('Sending messages with disappearing messages enabled', () => {
  it('stamps expiresAt and expirationPolicy on new messages', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');

    const before = Date.now();
    const send = await sendMessage(alice, convId, 'transient');
    expect(send.status).toBe(201);

    const stored = await Message.findById(send.body.data.message.id);
    expect(stored?.expiresAt).toBeInstanceOf(Date);
    const expiresAtMs = stored!.expiresAt!.getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 5_000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 5_000);
    expect(stored?.expirationPolicy).toBe('send_time');
    expect(send.body.data.message.expiresAt).toBeTruthy();
    expect(send.body.data.message.expirationPolicy).toBe('send_time');
  });

  it('does not stamp expiresAt when the setting is off', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    const send = await sendMessage(alice, convId, 'permanent');
    expect(send.status).toBe(201);
    const stored = await Message.findById(send.body.data.message.id);
    expect(stored?.expiresAt).toBeUndefined();
  });

  it('flipping the setting does not retroactively expire old messages', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    const old = await sendMessage(alice, convId, 'old message');
    await setDisappearing(alice, convId, '24h');
    const fresh = await sendMessage(alice, convId, 'fresh message');

    const oldStored = await Message.findById(old.body.data.message.id);
    const freshStored = await Message.findById(fresh.body.data.message.id);
    expect(oldStored?.expiresAt).toBeUndefined();
    expect(freshStored?.expiresAt).toBeInstanceOf(Date);
  });
});

describe('Cleanup job (expireMessagesOnce)', () => {
  it('redacts messages whose expiresAt has passed', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');
    const send = await sendMessage(alice, convId, 'self-destruct');

    // Force the message into the past.
    await Message.updateOne(
      { _id: send.body.data.message.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const result = await expireMessagesOnce();
    expect(result.expired).toBe(1);

    const stored = await Message.findById(send.body.data.message.id);
    expect(stored?.expiredAt).toBeInstanceOf(Date);
    expect(stored?.text).toBe('');
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.deletionReason).toBe('expired');
  });

  it('is idempotent across runs', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');
    const send = await sendMessage(alice, convId, 'one and done');
    await Message.updateOne(
      { _id: send.body.data.message.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const first = await expireMessagesOnce();
    const second = await expireMessagesOnce();
    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0);
  });

  it('does not touch messages whose expiresAt is still in the future', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');
    const send = await sendMessage(alice, convId, 'still alive');

    const result = await expireMessagesOnce();
    expect(result.expired).toBe(0);

    const stored = await Message.findById(send.body.data.message.id);
    expect(stored?.expiredAt).toBeUndefined();
    expect(stored?.text).toBe('still alive');
  });

  it('emits message.expired with a redacted DTO', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');
    const send = await sendMessage(alice, convId, 'broadcast me away');
    await Message.updateOne(
      { _id: send.body.data.message.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const events: Array<{ messageId: string; message: { text: unknown } }> = [];
    realtimeEvents.on('message.expired', (p) =>
      events.push(p as { messageId: string; message: { text: unknown } })
    );

    await expireMessagesOnce();
    expect(events).toHaveLength(1);
    expect(events[0].messageId).toBe(send.body.data.message.id);
    expect(events[0].message.text).toBeNull();
  });

  it('does not change deletion reason for already user-deleted messages', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');
    const send = await sendMessage(alice, convId, 'self-deleted');
    const messageId = send.body.data.message.id;

    await request(app)
      .delete(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${alice.token}`);

    await Message.updateOne(
      { _id: messageId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    await expireMessagesOnce();
    const stored = await Message.findById(messageId);
    expect(stored?.expiredAt).toBeInstanceOf(Date);
    // Original user-delete reason is preserved.
    expect(stored?.deletionReason).toBe('user_deleted');
  });
});

describe('Expired messages do not leak plaintext via the API', () => {
  it('GET /messages/:id returns text:null once expiresAt has passed', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');
    const send = await sendMessage(alice, convId, 'secret payload');
    const messageId = send.body.data.message.id;

    // Move expiresAt into the past but DO NOT run the cleanup job yet.
    await Message.updateOne(
      { _id: messageId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const res = await request(app)
      .get(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.message.text).toBeNull();
  });

  it('list endpoint also masks expired messages even before cleanup', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');
    const send = await sendMessage(alice, convId, 'list secret');
    await Message.updateOne(
      { _id: send.body.data.message.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const res = await request(app)
      .get(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].text).toBeNull();
  });

  it('after cleanup, the raw text in the DB is wiped', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');
    const send = await sendMessage(alice, convId, 'wipe me');
    await Message.updateOne(
      { _id: send.body.data.message.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    await expireMessagesOnce();
    const stored = await Message.findById(send.body.data.message.id);
    expect(stored?.text).toBe('');
  });
});

describe('POST /api/v1/messages/:id/expire-now', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .post(`/api/v1/messages/507f1f77bcf86cd799439011/expire-now`);
    expect(res.status).toBe(401);
  });

  it('lets the sender force-expire their own message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);
    const send = await sendMessage(alice, convId, 'oops sent');

    const res = await request(app)
      .post(`/api/v1/messages/${send.body.data.message.id}/expire-now`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.message.text).toBeNull();
    expect(res.body.data.message.deletionReason).toBe('expired');

    const stored = await Message.findById(send.body.data.message.id);
    expect(stored?.text).toBe('');
    expect(stored?.expiredAt).toBeInstanceOf(Date);
  });

  it('rejects a non-sender, non-moderator caller', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);
    const send = await sendMessage(alice, convId, 'mine');

    const res = await request(app)
      .post(`/api/v1/messages/${send.body.data.message.id}/expire-now`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(403);
  });

  it('a platform moderator can force-expire any message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const convId = await createGroup(alice, [bob.id]);
    const send = await sendMessage(alice, convId, 'mod take');

    const res = await request(app)
      .post(`/api/v1/messages/${send.body.data.message.id}/expire-now`)
      .set('Authorization', `Bearer ${mod.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.message.deletionReason).toBe('expired');
  });

  it('is idempotent on already-expired messages', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);
    const send = await sendMessage(alice, convId, 'twice');

    const first = await request(app)
      .post(`/api/v1/messages/${send.body.data.message.id}/expire-now`)
      .set('Authorization', `Bearer ${alice.token}`);
    const second = await request(app)
      .post(`/api/v1/messages/${send.body.data.message.id}/expire-now`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.message.text).toBeNull();
  });
});

describe('Direct chat with disappearing setting interaction', () => {
  it('updatedBy reflects the actor who flipped the setting', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    await setDisappearing(alice, convId, '24h');
    await setDisappearing(bob, convId, '7d');

    const conv = await Conversation.findById(convId);
    expect(conv?.settings.disappearingMessages.duration).toBe('7d');
    expect(conv?.settings.disappearingMessages.updatedBy?.toString()).toBe(
      bob.id
    );
  });
});
