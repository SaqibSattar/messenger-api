import request from 'supertest';
import argon2 from 'argon2';
import { buildApp } from '../../app';
import { startTestDb, stopTestDb, clearTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import {
  ROLES,
  type Role
} from '../permissions/permissions.constants';
import { AuditLog } from './auditLog.model';
import {
  AUDIT_ACTION,
  AUDIT_TARGET_TYPE
} from './auditLog.types';
import {
  persistAuditLog,
  sanitizeAuditMetadata
} from './auditLog.service';

const app = buildApp();

const PASSWORD = 'audit-tests-password-1';

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
// sanitizeAuditMetadata
// ---------------------------------------------------------------------------

describe('sanitizeAuditMetadata', () => {
  it('redacts known sensitive keys regardless of casing', () => {
    const out = sanitizeAuditMetadata({
      password: 'hunter2',
      Token: 'jwt-here',
      refreshToken: 'rt-here',
      AccessToken: 'at-here',
      cookie: 'session=1',
      secret: 'shh',
      otp: '123456',
      bearer: 'b',
      authorization: 'Bearer x',
      privateKey: 'pk',
      resetCode: '4242'
    });
    for (const key of Object.keys(out)) {
      expect(out[key]).toBe('[REDACTED]');
    }
  });

  it('drops Mongo operator keys and dot-path keys', () => {
    const out = sanitizeAuditMetadata({
      $set: { foo: 1 },
      'a.b': 'sneaky',
      legit: 'kept'
    });
    expect(out).toEqual({ legit: 'kept' });
  });

  it('truncates long string values', () => {
    const long = 'x'.repeat(2000);
    const out = sanitizeAuditMetadata({ note: long });
    expect((out.note as string).length).toBe(500);
    expect((out.note as string).endsWith('…')).toBe(true);
  });

  it('caps array length and recurses into nested objects', () => {
    const out = sanitizeAuditMetadata({
      items: Array.from({ length: 50 }).map((_, i) => ({
        index: i,
        token: 'leak'
      }))
    });
    const arr = out.items as unknown[];
    expect(arr.length).toBeLessThanOrEqual(33); // 32 + truncation marker
    // Each nested object should still have its sensitive key redacted.
    const first = arr[0] as Record<string, unknown>;
    expect(first.token).toBe('[REDACTED]');
    expect(first.index).toBe(0);
  });

  it('drops unsupported value types', () => {
    const sym = Symbol('x');
    const out = sanitizeAuditMetadata({
      fn: () => 1,
      sym,
      now: new Date(),
      keep: 'yes'
    });
    expect(out).toEqual({ keep: 'yes' });
  });
});

// ---------------------------------------------------------------------------
// persistAuditLog
// ---------------------------------------------------------------------------

describe('persistAuditLog', () => {
  it('creates an audit_logs document with sanitized metadata', async () => {
    await persistAuditLog({
      action: AUDIT_ACTION.MODERATION_ACTION,
      actorId: '507f1f77bcf86cd799439011',
      targetType: AUDIT_TARGET_TYPE.USER,
      targetId: '507f1f77bcf86cd799439012',
      requestId: 'req-1',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
      metadata: {
        actionType: 'warn_user',
        password: 'should-not-survive',
        nested: { token: 'gone', kept: true }
      }
    });

    const docs = await AuditLog.find({});
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.action).toBe(AUDIT_ACTION.MODERATION_ACTION);
    expect(doc.targetType).toBe(AUDIT_TARGET_TYPE.USER);
    expect(doc.targetId).toBe('507f1f77bcf86cd799439012');
    expect(doc.requestId).toBe('req-1');
    expect(doc.ipAddress).toBe('127.0.0.1');
    expect(doc.userAgent).toBe('jest');
    const meta = doc.metadata as Record<string, unknown>;
    expect(meta.actionType).toBe('warn_user');
    expect(meta.password).toBe('[REDACTED]');
    expect((meta.nested as Record<string, unknown>).token).toBe('[REDACTED]');
    expect((meta.nested as Record<string, unknown>).kept).toBe(true);
  });

  it('does not throw when called with an invalid actorId', async () => {
    await expect(
      persistAuditLog({
        action: AUDIT_ACTION.USER_LOGIN_FAILED,
        actorId: 'not-a-real-id',
        targetType: AUDIT_TARGET_TYPE.USER
      })
    ).resolves.toBeUndefined();
    const doc = await AuditLog.findOne({});
    expect(doc?.actorId).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/audit-logs
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/audit-logs', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app).get('/api/v1/admin/audit-logs');
    expect(res.status).toBe(401);
  });

  it('rejects callers without admin:audit:read', async () => {
    await createUser({ email: 'member@example.com', displayName: 'Member' });
    const token = await login('member@example.com');
    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns audit rows newest-first for an admin caller', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    await persistAuditLog({
      action: AUDIT_ACTION.USER_LOGIN_FAILED,
      targetType: AUDIT_TARGET_TYPE.USER,
      metadata: { identifierType: 'email', identifierHint: 'ad***(len=17)' }
    });
    await persistAuditLog({
      action: AUDIT_ACTION.MODERATION_ACTION,
      targetType: AUDIT_TARGET_TYPE.MODERATION_ACTION,
      targetId: '507f1f77bcf86cd799439099',
      metadata: { actionType: 'warn_user' }
    });
    const token = await login('admin@example.com');

    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    // Newest first.
    expect(res.body.data.items[0].action).toBe(AUDIT_ACTION.MODERATION_ACTION);
    expect(res.body.data.items[1].action).toBe(AUDIT_ACTION.USER_LOGIN_FAILED);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('paginates via cursor with a small limit', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    for (let i = 0; i < 5; i++) {
      await persistAuditLog({
        action: AUDIT_ACTION.MODERATION_ACTION,
        targetType: AUDIT_TARGET_TYPE.USER,
        metadata: { index: i }
      });
    }
    const token = await login('admin@example.com');

    const first = await request(app)
      .get('/api/v1/admin/audit-logs?limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.nextCursor).toBeTruthy();

    const second = await request(app)
      .get(`/api/v1/admin/audit-logs?limit=2&cursor=${first.body.data.nextCursor}`)
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.data.items).toHaveLength(2);
    // No overlap between pages.
    const firstIds = (first.body.data.items as Array<{ id: string }>).map(
      (i) => i.id
    );
    const secondIds = (second.body.data.items as Array<{ id: string }>).map(
      (i) => i.id
    );
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it('filters by action and targetType', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    await persistAuditLog({
      action: AUDIT_ACTION.USER_LOGIN_FAILED,
      targetType: AUDIT_TARGET_TYPE.USER
    });
    await persistAuditLog({
      action: AUDIT_ACTION.MODERATION_ACTION,
      targetType: AUDIT_TARGET_TYPE.MODERATION_ACTION
    });
    const token = await login('admin@example.com');

    const res = await request(app)
      .get(`/api/v1/admin/audit-logs?action=${AUDIT_ACTION.USER_LOGIN_FAILED}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].action).toBe(AUDIT_ACTION.USER_LOGIN_FAILED);
  });

  it('rejects an unknown query parameter', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .get('/api/v1/admin/audit-logs?wat=hello')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: sensitive action creates an audit log
// ---------------------------------------------------------------------------

describe('end-to-end audit emission', () => {
  it('records user.role.change when an admin promotes a member', async () => {
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

    const promote = await request(app)
      .patch(`/api/v1/admin/users/${target._id.toString()}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: ROLES.MODERATOR, reason: 'promotion' });
    expect(promote.status).toBe(200);

    const audit = await AuditLog.findOne({
      action: AUDIT_ACTION.USER_ROLE_CHANGE
    });
    expect(audit).toBeTruthy();
    expect(audit?.targetType).toBe(AUDIT_TARGET_TYPE.USER);
    expect(audit?.targetId).toBe(target._id.toString());
    const meta = audit?.metadata as Record<string, unknown>;
    expect(meta.previousRole).toBe(ROLES.MEMBER);
    expect(meta.newRole).toBe(ROLES.MODERATOR);
  });

  it('records user.login.failed when credentials are invalid', async () => {
    await createUser({ email: 'someone@example.com', displayName: 'Someone' });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'someone@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);

    const audit = await AuditLog.findOne({
      action: AUDIT_ACTION.USER_LOGIN_FAILED
    });
    expect(audit).toBeTruthy();
    expect(audit?.targetType).toBe(AUDIT_TARGET_TYPE.USER);
    const meta = audit?.metadata as Record<string, unknown>;
    expect(meta.identifierType).toBe('email');
    // The hint is coarse — should not contain the full email.
    expect(meta.identifierHint).not.toContain('someone@example.com');
    expect(typeof meta.identifierHint).toBe('string');
  });

  it('records user.password.changed when a user changes their password', async () => {
    const user = await createUser({
      email: 'pw@example.com',
      displayName: 'Pw'
    });
    const token = await login('pw@example.com');
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({
        currentPassword: PASSWORD,
        newPassword: 'NewPassword-12345!'
      });
    expect(res.status).toBe(200);

    const audit = await AuditLog.findOne({
      action: AUDIT_ACTION.USER_PASSWORD_CHANGED
    });
    expect(audit).toBeTruthy();
    expect(audit?.targetType).toBe(AUDIT_TARGET_TYPE.USER);
    expect(audit?.targetId).toBe(user._id.toString());
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/system-summary
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/system-summary', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app).get('/api/v1/admin/system-summary');
    expect(res.status).toBe(401);
  });

  it('rejects members lacking admin:system:read', async () => {
    await createUser({ email: 'member@example.com', displayName: 'Member' });
    const token = await login('member@example.com');
    const res = await request(app)
      .get('/api/v1/admin/system-summary')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns counts for an admin caller', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    await createUser({
      email: 'one@example.com',
      displayName: 'One'
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .get('/api/v1/admin/system-summary')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.users.total).toBe(2);
    expect(res.body.data.users.active).toBe(2);
    expect(res.body.data.users.suspended).toBe(0);
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
    expect(typeof res.body.data.conversations).toBe('number');
    expect(typeof res.body.data.dependencies.mongo).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// GET /metrics
// ---------------------------------------------------------------------------

describe('GET /metrics', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('rejects callers without admin:system:read', async () => {
    await createUser({ email: 'member@example.com', displayName: 'Member' });
    const token = await login('member@example.com');
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns privacy-safe metrics for an admin caller', async () => {
    await createUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: ROLES.ADMIN
    });
    const token = await login('admin@example.com');
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
    expect(typeof res.body.data.process.heapUsedBytes).toBe('number');
    expect(typeof res.body.data.process.rssBytes).toBe('number');
    expect(typeof res.body.data.process.pid).toBe('number');
    // Privacy check — no user-identifying fields should appear.
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/email|password|token|ipAddress/i);
  });
});
