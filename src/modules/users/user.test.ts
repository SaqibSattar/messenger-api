import request from 'supertest';
import argon2 from 'argon2';
import { buildApp } from '../../app';
import { startTestDb, stopTestDb, clearTestDb } from '../../tests/db';
import { Session } from '../sessions/session.model';
import { User } from './user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';

const app = buildApp();

const PASSWORD = 'correct horse battery';

const passwordHash = async () => argon2.hash(PASSWORD);

const createUser = async (overrides: {
  email: string;
  displayName: string;
  username?: string;
  role?: Role;
  privacySettings?: Record<string, boolean>;
}) => {
  const hash = await passwordHash();
  return User.create({
    email: overrides.email,
    passwordHash: hash,
    displayName: overrides.displayName,
    username: overrides.username,
    role: overrides.role ?? ROLES.MEMBER,
    privacySettings: overrides.privacySettings
  });
};

const login = async (email: string): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD });
  return res.body.data.tokens.accessToken as string;
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

describe('GET /api/v1/users/me', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('returns the authenticated user including private fields', async () => {
    await createUser({
      email: 'alice@example.com',
      displayName: 'Alice'
    });
    const token = await login('alice@example.com');

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe('alice@example.com');
    expect(res.body.data.user.displayName).toBe('Alice');
    expect(res.body.data.user.role).toBe(ROLES.MEMBER);
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.user.privacySettings).toEqual({
      discoverableByEmail: true,
      discoverableByPhone: true,
      discoverableByUsername: true,
      showLastSeen: true,
      showOnlineStatus: true
    });
  });
});

describe('PATCH /api/v1/users/me', () => {
  it('updates allowed fields and normalizes inputs', async () => {
    await createUser({ email: 'alice@example.com', displayName: 'Alice' });
    const token = await login('alice@example.com');

    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        displayName: '  Alice   Smith  ',
        username: 'AliceS',
        bio: 'hello​ world\r\nline 2',
        avatarUrl: 'https://cdn.example.com/avatars/alice.png',
        privacySettings: { discoverableByEmail: false }
      });

    expect(res.status).toBe(200);
    expect(res.body.data.user.displayName).toBe('Alice Smith');
    expect(res.body.data.user.username).toBe('alices');
    expect(res.body.data.user.bio).toBe('hello world\nline 2');
    expect(res.body.data.user.avatarUrl).toBe(
      'https://cdn.example.com/avatars/alice.png'
    );
    expect(res.body.data.user.privacySettings.discoverableByEmail).toBe(false);
    // Other privacy flags are preserved.
    expect(res.body.data.user.privacySettings.discoverableByUsername).toBe(true);
  });

  it('rejects unknown / privileged fields (mass assignment guard)', async () => {
    await createUser({ email: 'alice@example.com', displayName: 'Alice' });
    const token = await login('alice@example.com');

    const cases: Array<Record<string, unknown>> = [
      { role: ROLES.ADMIN },
      { status: 'active', displayName: 'X' },
      { passwordHash: 'attacker' },
      { customPermissions: ['admin:users:manage'] },
      { email: 'new@example.com' },
      { phone: '+15551234567' }
    ];

    for (const body of cases) {
      const res = await request(app)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    // Role was not changed.
    const user = await User.findOne({ email: 'alice@example.com' });
    expect(user?.role).toBe(ROLES.MEMBER);
  });

  it('rejects an empty patch body', async () => {
    await createUser({ email: 'alice@example.com', displayName: 'Alice' });
    const token = await login('alice@example.com');
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects invalid usernames', async () => {
    await createUser({ email: 'alice@example.com', displayName: 'Alice' });
    const token = await login('alice@example.com');
    const invalid = ['ab', '.alice', '1alice', 'alice..bob', 'alice space', 'alice!'];
    for (const username of invalid) {
      const res = await request(app)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ username });
      expect(res.status).toBe(400);
    }
  });

  it('rejects non-http(s) avatar URLs (no javascript: schemes)', async () => {
    await createUser({ email: 'alice@example.com', displayName: 'Alice' });
    const token = await login('alice@example.com');
    for (const avatarUrl of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'ftp://example.com/avatar.png'
    ]) {
      const res = await request(app)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ avatarUrl });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a taken username with a generic conflict', async () => {
    await createUser({
      email: 'alice@example.com',
      displayName: 'Alice',
      username: 'alice'
    });
    await createUser({ email: 'bob@example.com', displayName: 'Bob' });
    const token = await login('bob@example.com');

    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ username: 'alice' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    // Generic message — must not name the field that conflicted.
    expect(res.body.error.message).not.toMatch(/username|email|phone/i);
  });
});

describe('GET /api/v1/users/:userId/public', () => {
  it('returns the minimal public profile and never exposes private fields', async () => {
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target',
      username: 'target_user'
    });
    target.bio = 'about me';
    target.avatarUrl = 'https://cdn.example.com/a.png';
    await target.save();

    await createUser({ email: 'viewer@example.com', displayName: 'Viewer' });
    const token = await login('viewer@example.com');

    const res = await request(app)
      .get(`/api/v1/users/${target._id.toString()}/public`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const dto = res.body.data.user;
    expect(dto.id).toBe(target._id.toString());
    expect(dto.displayName).toBe('Target');
    expect(dto.username).toBe('target_user');
    expect(dto.bio).toBe('about me');
    expect(dto.avatarUrl).toBe('https://cdn.example.com/a.png');
    // These must never appear on the public DTO.
    expect(dto.email).toBeUndefined();
    expect(dto.phone).toBeUndefined();
    expect(dto.role).toBeUndefined();
    expect(dto.status).toBeUndefined();
    expect(dto.privacySettings).toBeUndefined();
    expect(dto.lastLoginAt).toBeUndefined();
    expect(dto.customPermissions).toBeUndefined();
    expect(dto.passwordHash).toBeUndefined();
  });

  it('returns 404 for an unknown user id', async () => {
    await createUser({ email: 'viewer@example.com', displayName: 'Viewer' });
    const token = await login('viewer@example.com');
    const res = await request(app)
      .get('/api/v1/users/507f1f77bcf86cd799439011/public')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed user id', async () => {
    await createUser({ email: 'viewer@example.com', displayName: 'Viewer' });
    const token = await login('viewer@example.com');
    const res = await request(app)
      .get('/api/v1/users/not-an-objectid/public')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a deactivated user', async () => {
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });
    target.status = 'deactivated';
    await target.save();
    await createUser({ email: 'viewer@example.com', displayName: 'Viewer' });
    const token = await login('viewer@example.com');
    const res = await request(app)
      .get(`/api/v1/users/${target._id.toString()}/public`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('rejects unauthenticated callers', async () => {
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });
    const res = await request(app).get(
      `/api/v1/users/${target._id.toString()}/public`
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/users/search', () => {
  it('finds a user by exact email and returns only the public DTO', async () => {
    await createUser({
      email: 'target@example.com',
      displayName: 'Target',
      username: 'target_user'
    });
    await createUser({ email: 'viewer@example.com', displayName: 'Viewer' });
    const token = await login('viewer@example.com');

    const res = await request(app)
      .get('/api/v1/users/search')
      .query({ email: 'target@example.com' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.users).toHaveLength(1);
    const dto = res.body.data.users[0];
    expect(dto.username).toBe('target_user');
    // Sensitive fields must never appear in search results.
    expect(dto.email).toBeUndefined();
    expect(dto.phone).toBeUndefined();
    expect(dto.role).toBeUndefined();
    expect(dto.privacySettings).toBeUndefined();
  });

  it('returns empty results when the target opted out of discovery by that field', async () => {
    await createUser({
      email: 'target@example.com',
      displayName: 'Target',
      username: 'target_user',
      privacySettings: { discoverableByEmail: false }
    });
    await createUser({ email: 'viewer@example.com', displayName: 'Viewer' });
    const token = await login('viewer@example.com');

    const byEmail = await request(app)
      .get('/api/v1/users/search')
      .query({ email: 'target@example.com' })
      .set('Authorization', `Bearer ${token}`);
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.users).toEqual([]);

    // Other discovery fields still work.
    const byUsername = await request(app)
      .get('/api/v1/users/search')
      .query({ username: 'target_user' })
      .set('Authorization', `Bearer ${token}`);
    expect(byUsername.status).toBe(200);
    expect(byUsername.body.data.users).toHaveLength(1);
  });

  it('does not support partial / substring matches', async () => {
    await createUser({
      email: 'target@example.com',
      displayName: 'Target',
      username: 'target_user'
    });
    await createUser({ email: 'viewer@example.com', displayName: 'Viewer' });
    const token = await login('viewer@example.com');

    const res = await request(app)
      .get('/api/v1/users/search')
      .query({ username: 'target' }) // substring, not exact
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.users).toEqual([]);
  });

  it('rejects multiple or zero search parameters', async () => {
    await createUser({ email: 'viewer@example.com', displayName: 'Viewer' });
    const token = await login('viewer@example.com');

    const none = await request(app)
      .get('/api/v1/users/search')
      .set('Authorization', `Bearer ${token}`);
    expect(none.status).toBe(400);

    const both = await request(app)
      .get('/api/v1/users/search')
      .query({ email: 'a@b.com', username: 'foo' })
      .set('Authorization', `Bearer ${token}`);
    expect(both.status).toBe(400);
  });

  it('does not return deactivated users', async () => {
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target',
      username: 'target_user'
    });
    target.status = 'deactivated';
    await target.save();

    await createUser({ email: 'viewer@example.com', displayName: 'Viewer' });
    const token = await login('viewer@example.com');

    const res = await request(app)
      .get('/api/v1/users/search')
      .query({ username: 'target_user' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.users).toEqual([]);
  });

  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .get('/api/v1/users/search')
      .query({ email: 'a@b.com' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/users/me/deactivate', () => {
  it('requires the current password', async () => {
    await createUser({ email: 'alice@example.com', displayName: 'Alice' });
    const token = await login('alice@example.com');

    const res = await request(app)
      .post('/api/v1/users/me/deactivate')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'wrong-password-xyz' });
    expect(res.status).toBe(401);

    const user = await User.findOne({ email: 'alice@example.com' });
    expect(user?.status).toBe('active');
  });

  it('deactivates the user, revokes sessions, and blocks future login', async () => {
    await createUser({ email: 'alice@example.com', displayName: 'Alice' });
    const token = await login('alice@example.com');

    const res = await request(app)
      .post('/api/v1/users/me/deactivate')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD, reason: 'leaving' });

    expect(res.status).toBe(200);

    const user = await User.findOne({ email: 'alice@example.com' });
    expect(user?.status).toBe('deactivated');
    expect(user?.deactivatedAt).toBeInstanceOf(Date);

    const activeSessions = await Session.countDocuments({
      userId: user?._id,
      revokedAt: { $exists: false }
    });
    expect(activeSessions).toBe(0);

    // Old token must stop working immediately.
    const meRes = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(401);

    // Login must also fail while deactivated.
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD });
    expect(loginRes.status).toBe(401);
  });
});
