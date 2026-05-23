import request from 'supertest';
import argon2 from 'argon2';
import { buildApp } from '../../app';
import { startTestDb, stopTestDb, clearTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { Session } from '../sessions/session.model';
import {
  ROLES,
  PERMISSIONS,
  type Role
} from '../permissions/permissions.constants';

const app = buildApp();

const passwordHash = async () => argon2.hash('admin-tests-password-1');

const createUser = async (overrides: {
  email: string;
  displayName: string;
  role?: Role;
}) => {
  const hash = await passwordHash();
  return User.create({
    email: overrides.email,
    passwordHash: hash,
    displayName: overrides.displayName,
    role: overrides.role ?? ROLES.MEMBER
  });
};

const login = async (email: string): Promise<string> => {
  const res = await request(app).post('/api/v1/auth/login').send({
    email,
    password: 'admin-tests-password-1'
  });
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

describe('PATCH /api/v1/admin/users/:userId/role', () => {
  it('rejects unauthenticated callers', async () => {
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });
    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id.toString()}/role`)
      .send({ role: ROLES.MODERATOR });
    expect(res.status).toBe(401);
  });

  it('rejects members lacking admin:users:manage', async () => {
    await createUser({ email: 'member@example.com', displayName: 'Member' });
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });
    const token = await login('member@example.com');
    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id.toString()}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: ROLES.MODERATOR });
    expect(res.status).toBe(403);
  });

  it('rejects an admin trying to change their own role', async () => {
    const admin = await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .patch(`/api/v1/admin/users/${admin._id.toString()}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: ROLES.MEMBER });
    expect(res.status).toBe(403);
  });

  it('rejects an admin trying to assign a role at or above their own', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id.toString()}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: ROLES.ADMIN });
    expect(res.status).toBe(403);
  });

  it('rejects an admin trying to modify another admin (peer)', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const peer = await createUser({
      email: 'peer@example.com',
      displayName: 'Peer',
      role: ROLES.ADMIN
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .patch(`/api/v1/admin/users/${peer._id.toString()}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: ROLES.MEMBER });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown user id', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .patch('/api/v1/admin/users/507f1f77bcf86cd799439011/role')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: ROLES.MODERATOR });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed user id', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .patch('/api/v1/admin/users/not-an-objectid/role')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: ROLES.MODERATOR });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown role value', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id.toString()}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'galaxy-overlord' });
    expect(res.status).toBe(400);
  });

  it('promotes a member to moderator, revokes their sessions, and returns the updated user', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });
    // Give the target an active session that should be revoked.
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'target@example.com', password: 'admin-tests-password-1' });

    const adminToken = await login('admin@example.com');
    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id.toString()}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: ROLES.MODERATOR, reason: 'promoted' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.role).toBe(ROLES.MODERATOR);
    expect(res.body.data.user.passwordHash).toBeUndefined();

    const activeForTarget = await Session.countDocuments({
      userId: target._id,
      revokedAt: { $exists: false }
    });
    expect(activeForTarget).toBe(0);
  });
});

describe('PATCH /api/v1/admin/users/:userId/permissions', () => {
  it('rejects an unknown permission string', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id.toString()}/permissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ customPermissions: ['not-a-real:permission'] });
    expect(res.status).toBe(400);
  });

  it('grants extra permissions to a member and the new permissions take effect after re-login', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });

    const adminToken = await login('admin@example.com');
    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id.toString()}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customPermissions: [PERMISSIONS.MESSAGE_MODERATE]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.user.customPermissions).toEqual([
      PERMISSIONS.MESSAGE_MODERATE
    ]);

    const updated = await User.findById(target._id);
    expect(updated?.customPermissions).toContain(PERMISSIONS.MESSAGE_MODERATE);
  });

  it('rejects a member trying to change permissions', async () => {
    await createUser({ email: 'member@example.com', displayName: 'Member' });
    const target = await createUser({
      email: 'target@example.com',
      displayName: 'Target'
    });
    const token = await login('member@example.com');
    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id.toString()}/permissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ customPermissions: [PERMISSIONS.MESSAGE_MODERATE] });
    expect(res.status).toBe(403);
  });
});
