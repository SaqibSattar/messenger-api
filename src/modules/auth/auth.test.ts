import request from 'supertest';
import { buildApp } from '../../app';
import { startTestDb, stopTestDb, clearTestDb } from '../../tests/db';
import { Session } from '../sessions/session.model';
import { User } from '../users/user.model';

const app = buildApp();

const validRegister = {
  email: 'alice@example.com',
  password: 'correct horse battery',
  displayName: 'Alice'
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

describe('POST /api/v1/auth/register', () => {
  it('registers a new user and returns tokens + user DTO without sensitive fields', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(validRegister);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe('alice@example.com');
    expect(res.body.data.user.displayName).toBe('Alice');
    expect(res.body.data.user.role).toBe('member');
    expect(res.body.data.user.id).toBeDefined();
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
    expect(res.body.data.tokens.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.tokens.accessTokenExpiresInSeconds).toBeGreaterThan(0);
  });

  it('rejects duplicate registration with a generic conflict message', async () => {
    await request(app).post('/api/v1/auth/register').send(validRegister);
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(validRegister);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONFLICT');
    // Generic — avoid leaking which identifier is taken.
    expect(res.body.error.message).not.toMatch(/email|phone/i);
  });

  it('rejects when neither email nor phone is supplied', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ password: validRegister.password, displayName: 'X' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects too-short passwords', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'bob@example.com',
      password: 'short',
      displayName: 'Bob'
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/v1/auth/register').send(validRegister);
  });

  it('logs in with valid credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: validRegister.email,
      password: validRegister.password
    });

    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
    expect(res.body.data.tokens.refreshToken).toEqual(expect.any(String));
  });

  it('returns the same generic 401 for wrong password and missing user', async () => {
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: validRegister.email, password: 'incorrect-password-x' });

    const missingUser = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'incorrect-password-x' });

    expect(wrongPassword.status).toBe(401);
    expect(missingUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(missingUser.body.error.message);
    expect(wrongPassword.body.error.code).toBe(missingUser.body.error.code);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  const setup = async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(validRegister);
    return res.body.data.tokens as {
      accessToken: string;
      refreshToken: string;
    };
  };

  it('rotates refresh tokens — old token stops working after a refresh', async () => {
    const { refreshToken } = await setup();

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    expect(rotated.status).toBe(200);
    expect(rotated.body.data.tokens.refreshToken).not.toBe(refreshToken);

    // Replaying the old (now-rotated) refresh token must fail and revoke
    // every session for the user.
    const reused = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    expect(reused.status).toBe(401);

    const activeSessions = await Session.countDocuments({
      revokedAt: { $exists: false }
    });
    expect(activeSessions).toBe(0);
  });

  it('rejects an invalid refresh token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'not-a-real-token-but-long-enough-1234567890' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the current session', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send(validRegister);
    const { refreshToken } = reg.body.data.tokens;

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken });
    expect(res.status).toBe(200);

    const active = await Session.countDocuments({
      revokedAt: { $exists: false }
    });
    expect(active).toBe(0);

    // Refreshing with the revoked token must fail.
    const reuse = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(reuse.status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout-all', () => {
  it('revokes every active session for the user', async () => {
    const first = await request(app)
      .post('/api/v1/auth/register')
      .send(validRegister);
    const accessToken = first.body.data.tokens.accessToken as string;

    // Second login creates a second active session.
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: validRegister.email, password: validRegister.password });

    const before = await Session.countDocuments({
      revokedAt: { $exists: false }
    });
    expect(before).toBe(2);

    const res = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(2);

    const after = await Session.countDocuments({
      revokedAt: { $exists: false }
    });
    expect(after).toBe(0);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/auth/logout-all');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/change-password', () => {
  it('changes password and revokes existing sessions', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send(validRegister);
    const { accessToken, refreshToken } = reg.body.data.tokens;

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        currentPassword: validRegister.password,
        newPassword: 'new-strong-password-1'
      });

    expect(res.status).toBe(200);

    const active = await Session.countDocuments({
      revokedAt: { $exists: false }
    });
    expect(active).toBe(0);

    // Pre-change refresh token must no longer rotate.
    const reuse = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(reuse.status).toBe(401);

    // New password works.
    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: validRegister.email, password: 'new-strong-password-1' });
    expect(relogin.status).toBe(200);
  });

  it('rejects when current password is wrong', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send(validRegister);
    const { accessToken } = reg.body.data.tokens;

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        currentPassword: 'wrong-password-xyz',
        newPassword: 'another-strong-password-1'
      });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the authenticated user', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send(validRegister);
    const { accessToken } = reg.body.data.tokens;

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(validRegister.email);
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('rejects without a bearer token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a token from a deleted user', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send(validRegister);
    const { accessToken } = reg.body.data.tokens;
    await User.deleteMany({});

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/forgot-password', () => {
  it('responds identically for known and unknown accounts', async () => {
    await request(app).post('/api/v1/auth/register').send(validRegister);

    const known = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: validRegister.email });
    const unknown = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });
});
