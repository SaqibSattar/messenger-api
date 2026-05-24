import request from 'supertest';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { Device } from './device.model';
import {
  DEVICE_PLATFORM,
  DEVICE_PUSH_PROVIDER,
  DEVICE_STALE_AFTER_DAYS
} from './device.types';
import { cleanupStaleDevices } from './device.service';

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

const register = (actor: Seeded, body: Record<string, unknown>) =>
  request(app)
    .post('/api/v1/devices')
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
// Registration
// ---------------------------------------------------------------------------

describe('POST /api/v1/devices', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .post('/api/v1/devices')
      .send({
        platform: DEVICE_PLATFORM.IOS,
        pushProvider: DEVICE_PUSH_PROVIDER.APNS,
        pushToken: 'tok-1'
      });
    expect(res.status).toBe(401);
  });

  it('creates a new device row for the caller', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'apns-tok-alice',
      deviceName: "Alice's iPhone",
      appVersion: '1.0.0',
      locale: 'en-US'
    });
    expect(res.status).toBe(201);
    expect(res.body.data.device.userId).toBe(alice.id);
    // pushToken must never appear in the DTO.
    expect(res.body.data.device.pushToken).toBeUndefined();
    expect(res.body.data.device.platform).toBe(DEVICE_PLATFORM.IOS);
    expect(res.body.data.device.deviceName).toBe("Alice's iPhone");
  });

  it('rejects malformed bodies (unknown fields, missing token)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');

    const unknownField = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'a',
      injected: 'bad'
    });
    expect(unknownField.status).toBe(400);

    const missingToken = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS
    });
    expect(missingToken.status).toBe(400);
  });

  it('updates the existing row when the same user re-registers a token', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'apns-tok',
      deviceName: 'Old name'
    });
    const second = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'apns-tok',
      deviceName: 'New name'
    });
    expect(second.status).toBe(201);
    expect(second.body.data.device.deviceName).toBe('New name');

    const count = await Device.countDocuments({ userId: alice.id });
    expect(count).toBe(1);
  });

  it('reassigns a token from one user to another (account swap)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'shared-tok'
    });
    const swap = await register(bob, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'shared-tok'
    });
    expect(swap.status).toBe(201);

    // Alice no longer owns the token; Bob does. The total row count is 1.
    const aliceRows = await Device.countDocuments({ userId: alice.id });
    const bobRows = await Device.countDocuments({ userId: bob.id });
    expect(aliceRows).toBe(0);
    expect(bobRows).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe('GET /api/v1/devices', () => {
  it('only returns the caller-owned devices', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'tok-a-1'
    });
    await register(bob, {
      platform: DEVICE_PLATFORM.ANDROID,
      pushProvider: DEVICE_PUSH_PROVIDER.FCM,
      pushToken: 'tok-b-1'
    });

    const aliceList = await request(app)
      .get('/api/v1/devices')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.data.items).toHaveLength(1);
    expect(aliceList.body.data.items[0].userId).toBe(alice.id);
    // No tokens leak out of the list either.
    expect(aliceList.body.data.items[0].pushToken).toBeUndefined();
  });

  it('hides revoked devices by default and surfaces them with includeRevoked', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const reg = await register(alice, {
      platform: DEVICE_PLATFORM.WEB,
      pushProvider: DEVICE_PUSH_PROVIDER.WEB_PUSH,
      pushToken: 'tok-web'
    });
    const deviceId = reg.body.data.device.id as string;
    await request(app)
      .delete(`/api/v1/devices/${deviceId}`)
      .set('Authorization', `Bearer ${alice.token}`);

    const hidden = await request(app)
      .get('/api/v1/devices')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(hidden.body.data.items).toHaveLength(0);

    const shown = await request(app)
      .get('/api/v1/devices?includeRevoked=true')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(shown.body.data.items).toHaveLength(1);
    expect(shown.body.data.items[0].revokedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// PATCH /:deviceId
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/devices/:deviceId', () => {
  it('updates device metadata for the owner', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const reg = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'tok-1',
      deviceName: 'old'
    });
    const id = reg.body.data.device.id as string;

    const res = await request(app)
      .patch(`/api/v1/devices/${id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ deviceName: 'new', appVersion: '2.0.0' });
    expect(res.status).toBe(200);
    expect(res.body.data.device.deviceName).toBe('new');
    expect(res.body.data.device.appVersion).toBe('2.0.0');
  });

  it('returns 404 when the device belongs to another user (no leak)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const reg = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'tok-1'
    });
    const id = reg.body.data.device.id as string;

    const res = await request(app)
      .patch(`/api/v1/devices/${id}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ deviceName: 'pwned' });
    expect(res.status).toBe(404);

    const fresh = await Device.findById(id);
    expect(fresh?.deviceName).not.toBe('pwned');
  });

  it('rejects updates to revoked devices', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const reg = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'tok-1'
    });
    const id = reg.body.data.device.id as string;
    await request(app)
      .delete(`/api/v1/devices/${id}`)
      .set('Authorization', `Bearer ${alice.token}`);

    const res = await request(app)
      .patch(`/api/v1/devices/${id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ deviceName: 'still alive?' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:deviceId (unregister)
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/devices/:deviceId', () => {
  it('soft-revokes the caller-owned device (idempotent)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const reg = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'tok-1'
    });
    const id = reg.body.data.device.id as string;

    const first = await request(app)
      .delete(`/api/v1/devices/${id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(first.status).toBe(200);
    const firstRevokedAt = first.body.data.device.revokedAt as string;
    expect(firstRevokedAt).toBeTruthy();

    const second = await request(app)
      .delete(`/api/v1/devices/${id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(second.status).toBe(200);
    expect(second.body.data.device.revokedAt).toBe(firstRevokedAt);
  });

  it('returns 404 when revoking another user device', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const reg = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'tok-1'
    });
    const id = reg.body.data.device.id as string;
    const res = await request(app)
      .delete(`/api/v1/devices/${id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(404);

    const stored = await Device.findById(id);
    expect(stored?.revokedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('cleanupStaleDevices', () => {
  it('removes devices that have not checked in within the stale window', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const recent = await register(alice, {
      platform: DEVICE_PLATFORM.IOS,
      pushProvider: DEVICE_PUSH_PROVIDER.APNS,
      pushToken: 'recent'
    });
    const old = await register(alice, {
      platform: DEVICE_PLATFORM.ANDROID,
      pushProvider: DEVICE_PUSH_PROVIDER.FCM,
      pushToken: 'old'
    });
    const oldId = old.body.data.device.id as string;

    // Backdate the "old" device past the stale window.
    const past = new Date(
      Date.now() - (DEVICE_STALE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000
    );
    await Device.updateOne(
      { _id: new mongoose.Types.ObjectId(oldId) },
      { $set: { lastSeenAt: past } }
    );

    const result = await cleanupStaleDevices();
    expect(result.removed).toBe(1);
    expect(result.scanned).toBe(1);

    const remaining = await Device.find({ userId: alice.id });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]._id.toString()).toBe(recent.body.data.device.id);
  });
});
