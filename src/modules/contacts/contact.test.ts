import request from 'supertest';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { Contact } from './contact.model';
import { ContactRequest } from './contactRequest.model';
import { CONTACT_REQUEST_STATUS } from './contact.types';

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

const sendRequest = async (
  from: Seeded,
  toId: string,
  message?: string
) =>
  request(app)
    .post('/api/v1/contacts/requests')
    .set('Authorization', `Bearer ${from.token}`)
    .send({ receiverId: toId, ...(message ? { message } : {}) });

const acceptRequest = (actor: Seeded, requestId: string) =>
  request(app)
    .post(`/api/v1/contacts/requests/${requestId}/accept`)
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

describe('POST /api/v1/contacts/requests', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .post('/api/v1/contacts/requests')
      .send({ receiverId: new mongoose.Types.ObjectId().toString() });
    expect(res.status).toBe(401);
  });

  it('rejects requesting yourself', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await sendRequest(alice, alice.id);
    expect(res.status).toBe(400);
  });

  it('rejects a request to a non-existent user', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await sendRequest(
      alice,
      new mongoose.Types.ObjectId().toString()
    );
    expect(res.status).toBe(404);
  });

  it('creates a pending request', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const res = await sendRequest(alice, bob.id, 'hi!');
    expect(res.status).toBe(201);
    expect(res.body.data.request.status).toBe(CONTACT_REQUEST_STATUS.PENDING);
    expect(res.body.data.request.senderId).toBe(alice.id);
    expect(res.body.data.request.receiverId).toBe(bob.id);
    expect(res.body.data.request.message).toBe('hi!');
  });

  it('prevents a duplicate pending request to the same receiver', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    await sendRequest(alice, bob.id);
    const dup = await sendRequest(alice, bob.id);
    expect(dup.status).toBe(409);
  });

  it('rejects a request when either side has blocked', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    // Alice blocks Bob → Alice cannot request Bob.
    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ blockedUserId: bob.id });
    const r1 = await sendRequest(alice, bob.id);
    expect(r1.status).toBe(403);
    // Bob also cannot request Alice in the opposite direction.
    const r2 = await sendRequest(bob, alice.id);
    expect(r2.status).toBe(403);
  });

  it('refuses a fresh request when the reverse pending request exists', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    await sendRequest(alice, bob.id);
    const reverse = await sendRequest(bob, alice.id);
    expect(reverse.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

describe('POST /api/v1/contacts/requests/:requestId/accept', () => {
  it('lets the receiver accept and creates the mutual contact rows', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await sendRequest(alice, bob.id);
    const requestId = created.body.data.request.id;

    const res = await acceptRequest(bob, requestId);
    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe(CONTACT_REQUEST_STATUS.ACCEPTED);

    const contacts = await Contact.find();
    expect(contacts).toHaveLength(2);
    const pairs = contacts.map((c) => [
      c.userId.toString(),
      c.contactUserId.toString()
    ]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        [alice.id, bob.id],
        [bob.id, alice.id]
      ])
    );
  });

  it('forbids the sender from accepting their own request', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await sendRequest(alice, bob.id);
    const res = await acceptRequest(alice, created.body.data.request.id);
    // Sender pretends to be receiver → 404 (no leak).
    expect(res.status).toBe(404);
  });

  it('rejects accepting a non-pending request', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await sendRequest(alice, bob.id);
    await acceptRequest(bob, created.body.data.request.id);
    const second = await acceptRequest(bob, created.body.data.request.id);
    expect(second.status).toBe(409);
  });

  it('rejects an accept where a third party tampers with the id', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const created = await sendRequest(alice, bob.id);
    const res = await acceptRequest(eve, created.body.data.request.id);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Decline / cancel
// ---------------------------------------------------------------------------

describe('POST /api/v1/contacts/requests/:requestId/decline', () => {
  it('marks the request as declined and does not create contacts', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await sendRequest(alice, bob.id);

    const res = await request(app)
      .post(
        `/api/v1/contacts/requests/${created.body.data.request.id}/decline`
      )
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe(CONTACT_REQUEST_STATUS.DECLINED);
    const contacts = await Contact.countDocuments();
    expect(contacts).toBe(0);
  });

  it('rejects a sender trying to decline their own request', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await sendRequest(alice, bob.id);
    const res = await request(app)
      .post(
        `/api/v1/contacts/requests/${created.body.data.request.id}/decline`
      )
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/contacts/requests/:requestId (cancel)', () => {
  it('lets the sender cancel a pending request', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await sendRequest(alice, bob.id);

    const res = await request(app)
      .delete(`/api/v1/contacts/requests/${created.body.data.request.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe(
      CONTACT_REQUEST_STATUS.CANCELLED
    );
  });

  it('forbids the receiver from cancelling', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await sendRequest(alice, bob.id);
    const res = await request(app)
      .delete(`/api/v1/contacts/requests/${created.body.data.request.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

describe('GET /api/v1/contacts/requests/{incoming,outgoing}', () => {
  it('returns only the caller-owned incoming requests', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');
    await sendRequest(alice, bob.id);
    await sendRequest(carol, bob.id);

    const res = await request(app)
      .get('/api/v1/contacts/requests/incoming')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items[0].user.displayName).toBeTruthy();
  });

  it('returns only the caller-owned outgoing requests', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');
    await sendRequest(alice, bob.id);
    await sendRequest(alice, carol.id);

    const res = await request(app)
      .get('/api/v1/contacts/requests/outgoing')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
  });
});

describe('GET /api/v1/contacts', () => {
  it('lists the caller contacts and excludes other users contacts', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    const r1 = await sendRequest(alice, bob.id);
    await acceptRequest(bob, r1.body.data.request.id);
    const r2 = await sendRequest(alice, carol.id);
    await acceptRequest(carol, r2.body.data.request.id);

    const aliceList = await request(app)
      .get('/api/v1/contacts')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.data.items).toHaveLength(2);
    const ids = aliceList.body.data.items.map(
      (i: { user: { id: string } }) => i.user.id
    );
    expect(ids.sort()).toEqual([bob.id, carol.id].sort());

    // Bob only has Alice. Carol's contact should not leak.
    const bobList = await request(app)
      .get('/api/v1/contacts')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(bobList.body.data.items).toHaveLength(1);
    expect(bobList.body.data.items[0].user.id).toBe(alice.id);
  });
});

describe('DELETE /api/v1/contacts/:userId (remove contact)', () => {
  it('removes both directed rows', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await sendRequest(alice, bob.id);
    await acceptRequest(bob, created.body.data.request.id);

    const res = await request(app)
      .delete(`/api/v1/contacts/${bob.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);

    const remaining = await Contact.countDocuments();
    expect(remaining).toBe(0);
  });

  it('returns 404 if not a contact', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const res = await request(app)
      .delete(`/api/v1/contacts/${bob.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Sanity: ContactRequest partial-unique index lets a fresh request open
// after the prior one moves to a terminal state.
// ---------------------------------------------------------------------------

test('ContactRequest model allows a new pending request after decline', async () => {
  const alice = await seedUser('alice@example.com', 'Alice');
  const bob = await seedUser('bob@example.com', 'Bob');
  const created = await sendRequest(alice, bob.id);
  // Decline → terminal state.
  await request(app)
    .post(`/api/v1/contacts/requests/${created.body.data.request.id}/decline`)
    .set('Authorization', `Bearer ${bob.token}`);

  const again = await sendRequest(alice, bob.id);
  expect(again.status).toBe(201);

  const allRows = await ContactRequest.countDocuments({
    senderId: alice.id,
    receiverId: bob.id
  });
  expect(allRows).toBe(2); // historic declined + new pending
});
