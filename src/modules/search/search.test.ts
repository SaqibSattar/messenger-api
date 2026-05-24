import request from 'supertest';
import argon2 from 'argon2';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import {
  ROLES,
  type Permission,
  type Role
} from '../permissions/permissions.constants';

const app = buildApp();
const PASSWORD = 'correct horse battery';

const createUser = async (overrides: {
  email: string;
  displayName: string;
  username?: string;
  role?: Role;
  customPermissions?: Permission[];
  privacySettings?: Record<string, boolean>;
}) => {
  const hash = await argon2.hash(PASSWORD);
  return User.create({
    email: overrides.email,
    passwordHash: hash,
    displayName: overrides.displayName,
    username: overrides.username,
    role: overrides.role ?? ROLES.MEMBER,
    customPermissions: overrides.customPermissions ?? [],
    privacySettings: overrides.privacySettings
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
  opts: {
    username?: string;
    role?: Role;
    customPermissions?: Permission[];
    privacySettings?: Record<string, boolean>;
  } = {}
): Promise<Seeded> => {
  const u = await createUser({
    email,
    displayName,
    username: opts.username,
    role: opts.role,
    customPermissions: opts.customPermissions,
    privacySettings: opts.privacySettings
  });
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
// Conversation search
// ---------------------------------------------------------------------------

describe('GET /api/v1/search/conversations', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .get('/api/v1/search/conversations')
      .query({ q: 'team' });
    expect(res.status).toBe(401);
  });

  it('rejects queries below the minimum length', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .get('/api/v1/search/conversations')
      .query({ q: 'a' })
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(400);
  });

  it('only returns groups the caller is a member of', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    // Alice owns a group called "Alpha Team" (Bob is a member).
    await createGroup(alice, [bob.id], 'Alpha Team');
    // Carol owns a separate group also matching the query — Bob must not
    // see it.
    await createGroup(carol, [alice.id], 'Alpha Squad');

    const res = await request(app)
      .get('/api/v1/search/conversations')
      .query({ q: 'alpha' })
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].title).toBe('Alpha Team');
  });

  it('treats regex metacharacters as literal text (no NoSQL injection)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    await createGroup(alice, [bob.id], 'Team Project');

    // `.*` should NOT match anything; the literal characters are absent.
    const res = await request(app)
      .get('/api/v1/search/conversations')
      .query({ q: '.*' })
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Message search
// ---------------------------------------------------------------------------

describe('GET /api/v1/search/messages', () => {
  it('only returns messages from conversations the caller belongs to', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');

    const aliceBob = await createDirect(alice, bob);
    await sendMessage(alice, aliceBob, 'secret token alpha');

    const res = await request(app)
      .get('/api/v1/search/messages')
      .query({ q: 'secret' })
      .set('Authorization', `Bearer ${eve.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('returns matches for the caller and excludes deleted messages', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const conv = await createDirect(alice, bob);

    const keep = await sendMessage(alice, conv, 'keep this match');
    const drop = await sendMessage(alice, conv, 'drop this match');

    // Soft-delete the second message — it must not appear in search.
    await request(app)
      .delete(`/api/v1/messages/${drop.body.data.message.id}`)
      .set('Authorization', `Bearer ${alice.token}`);

    const res = await request(app)
      .get('/api/v1/search/messages')
      .query({ q: 'match' })
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].message.id).toBe(keep.body.data.message.id);
    expect(res.body.data.items[0].message.text).toBe('keep this match');
  });

  it('rejects pinning to a non-member conversation with 404', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const conv = await createDirect(alice, bob);

    const res = await request(app)
      .get('/api/v1/search/messages')
      .query({ q: 'anything', conversationId: conv })
      .set('Authorization', `Bearer ${eve.token}`);
    expect(res.status).toBe(404);
  });

  it('enforces the cap on query length', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .get('/api/v1/search/messages')
      .query({ q: 'x'.repeat(2000) })
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// User search
// ---------------------------------------------------------------------------

describe('GET /api/v1/search/users', () => {
  it('returns only public DTOs, never private fields', async () => {
    await seedUser('target@example.com', 'Target Name', {
      username: 'target_user'
    });
    const viewer = await seedUser('viewer@example.com', 'Viewer');

    const res = await request(app)
      .get('/api/v1/search/users')
      .query({ q: 'target' })
      .set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    const dto = res.body.data.items[0];
    expect(dto.username).toBe('target_user');
    expect(dto.displayName).toBe('Target Name');
    expect(dto.email).toBeUndefined();
    expect(dto.phone).toBeUndefined();
    expect(dto.role).toBeUndefined();
    expect(dto.privacySettings).toBeUndefined();
    expect(dto.passwordHash).toBeUndefined();
  });

  it('respects discoverableByUsername=false', async () => {
    await seedUser('hidden@example.com', 'Hidden User', {
      username: 'hidden_one',
      privacySettings: { discoverableByUsername: false }
    });
    const viewer = await seedUser('viewer@example.com', 'Viewer');

    const res = await request(app)
      .get('/api/v1/search/users')
      .query({ q: 'hidden' })
      .set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('does not include the caller in their own results', async () => {
    const me = await seedUser('me@example.com', 'Findme', {
      username: 'findme'
    });
    const res = await request(app)
      .get('/api/v1/search/users')
      .query({ q: 'findme' })
      .set('Authorization', `Bearer ${me.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('does not include deactivated users', async () => {
    const target = await createUser({
      email: 'gone@example.com',
      displayName: 'Gone User',
      username: 'gone_user'
    });
    target.status = 'deactivated';
    await target.save();

    const viewer = await seedUser('viewer@example.com', 'Viewer');
    const res = await request(app)
      .get('/api/v1/search/users')
      .query({ q: 'gone' })
      .set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});
