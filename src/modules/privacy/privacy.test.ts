import request from 'supertest';
import argon2 from 'argon2';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { PRIVACY_AUDIENCE } from '../users/user.types';

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

const becomeContacts = async (a: Seeded, b: Seeded): Promise<void> => {
  const created = await request(app)
    .post('/api/v1/contacts/requests')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ receiverId: b.id });
  await request(app)
    .post(`/api/v1/contacts/requests/${created.body.data.request.id}/accept`)
    .set('Authorization', `Bearer ${b.token}`);
};

const setPrivacy = (actor: Seeded, body: object) =>
  request(app)
    .patch('/api/v1/privacy-settings')
    .set('Authorization', `Bearer ${actor.token}`)
    .send(body);

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
// Get/update
// ---------------------------------------------------------------------------

describe('GET /api/v1/privacy-settings', () => {
  it('returns defaults for a fresh account', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .get('/api/v1/privacy-settings')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.privacySettings.whoCanFindMe).toBe(
      PRIVACY_AUDIENCE.EVERYONE
    );
    expect(res.body.data.privacySettings.whoCanMessageMe).toBe(
      PRIVACY_AUDIENCE.EVERYONE
    );
    expect(res.body.data.privacySettings.readReceiptsEnabled).toBe(true);
    expect(res.body.data.privacySettings.profilePhotoVisibility).toBe(
      PRIVACY_AUDIENCE.EVERYONE
    );
  });
});

describe('PATCH /api/v1/privacy-settings', () => {
  it('updates audience-scoped settings', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await setPrivacy(alice, {
      whoCanFindMe: PRIVACY_AUDIENCE.CONTACTS,
      whoCanMessageMe: PRIVACY_AUDIENCE.NOBODY,
      readReceiptsEnabled: false
    });
    expect(res.status).toBe(200);
    expect(res.body.data.privacySettings.whoCanFindMe).toBe(
      PRIVACY_AUDIENCE.CONTACTS
    );
    expect(res.body.data.privacySettings.whoCanMessageMe).toBe(
      PRIVACY_AUDIENCE.NOBODY
    );
    expect(res.body.data.privacySettings.readReceiptsEnabled).toBe(false);
  });

  it('rejects unknown audience values', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await setPrivacy(alice, { whoCanFindMe: 'mars' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty payload', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await setPrivacy(alice, {});
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Search enforcement: whoCanFindMe
// ---------------------------------------------------------------------------

describe('whoCanFindMe gates user search', () => {
  it('hides a `nobody` subject from exact email search', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    await setPrivacy(bob, { whoCanFindMe: PRIVACY_AUDIENCE.NOBODY });

    const res = await request(app)
      .get('/api/v1/users/search')
      .query({ email: bob.email })
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.users).toHaveLength(0);
  });

  it('only surfaces a `contacts` subject to actual contacts', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');
    await setPrivacy(carol, { whoCanFindMe: PRIVACY_AUDIENCE.CONTACTS });

    const beforeBob = await request(app)
      .get('/api/v1/users/search')
      .query({ email: carol.email })
      .set('Authorization', `Bearer ${bob.token}`);
    expect(beforeBob.body.data.users).toHaveLength(0);

    await becomeContacts(alice, carol);

    const aliceFinds = await request(app)
      .get('/api/v1/users/search')
      .query({ email: carol.email })
      .set('Authorization', `Bearer ${alice.token}`);
    expect(aliceFinds.body.data.users).toHaveLength(1);
  });

  it('text-search /search/users also honors whoCanFindMe', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const target = await seedUser('hidden@example.com', 'HiddenPerson');
    await setPrivacy(target, { whoCanFindMe: PRIVACY_AUDIENCE.NOBODY });

    const res = await request(app)
      .get('/api/v1/search/users')
      .query({ q: 'HiddenPerson' })
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DM enforcement: whoCanMessageMe
// ---------------------------------------------------------------------------

describe('whoCanMessageMe gates direct conversation creation', () => {
  it('blocks DM creation when the receiver opted out', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    await setPrivacy(bob, { whoCanMessageMe: PRIVACY_AUDIENCE.NOBODY });

    const res = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    expect(res.status).toBe(403);
  });

  it('allows DM creation when the receiver restricts to contacts and the caller is one', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    await setPrivacy(bob, { whoCanMessageMe: PRIVACY_AUDIENCE.CONTACTS });

    const blocked = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    expect(blocked.status).toBe(403);

    await becomeContacts(alice, bob);

    const ok = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    expect(ok.status).toBe(201);
  });

  it('stops new messages after the receiver flips whoCanMessageMe to nobody', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const conv = await request(app)
      .post('/api/v1/conversations/direct')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ participantId: bob.id });
    expect(conv.status).toBe(201);
    const convId = conv.body.data.conversation.id;

    const firstSend = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'before' });
    expect(firstSend.status).toBe(201);

    await setPrivacy(bob, { whoCanMessageMe: PRIVACY_AUDIENCE.NOBODY });

    const blockedSend = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'after' });
    expect(blockedSend.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Profile photo visibility
// ---------------------------------------------------------------------------

describe('profilePhotoVisibility gates public profile avatar', () => {
  it('hides avatar from a non-contact when set to contacts', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    // Give Bob an avatar so the gate has something to mask.
    await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ avatarUrl: 'https://example.com/avatar.png' });
    await setPrivacy(bob, {
      profilePhotoVisibility: PRIVACY_AUDIENCE.CONTACTS
    });

    const hidden = await request(app)
      .get(`/api/v1/users/${bob.id}/public`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(hidden.body.data.user.avatarUrl).toBeUndefined();

    await becomeContacts(alice, bob);

    const visible = await request(app)
      .get(`/api/v1/users/${bob.id}/public`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(visible.body.data.user.avatarUrl).toBe(
      'https://example.com/avatar.png'
    );
  });

  it('always shows your own avatar to yourself', async () => {
    const bob = await seedUser('bob@example.com', 'Bob');
    await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ avatarUrl: 'https://example.com/avatar.png' });
    await setPrivacy(bob, {
      profilePhotoVisibility: PRIVACY_AUDIENCE.NOBODY
    });

    const me = await request(app)
      .get(`/api/v1/users/${bob.id}/public`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(me.body.data.user.avatarUrl).toBe(
      'https://example.com/avatar.png'
    );
  });
});
