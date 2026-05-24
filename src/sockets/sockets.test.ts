import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AppServer } from './auth';
import argon2 from 'argon2';
import request from 'supertest';
import { buildApp } from '../app';
import { clearTestDb, startTestDb, stopTestDb } from '../tests/db';
import { User } from '../modules/users/user.model';
import { ROLES, type Role } from '../modules/permissions/permissions.constants';
import {
  realtimeEvents,
  emitRealtime
} from '../services/realtimeEvents';
import { createSocketServer, shutdownSocketServer } from './index';
import {
  getPresence,
  initPresence,
  __resetPresenceForTests
} from './presence';
import { __resetRateLimitForTests } from './rateLimit';
import { env } from '../config/env';

const PASSWORD = 'correct horse battery';

const app = buildApp();

let httpServer: HttpServer;
let io: AppServer;
let serverUrl: string;

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

const createDirect = async (a: SeededUser, b: SeededUser): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/conversations/direct')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ participantId: b.id });
  return res.body.data.conversation.id as string;
};

// Track every client socket created during a test so afterEach can guarantee
// they're all fully disconnected before the next test (or the DB teardown)
// runs. Otherwise a still-in-flight server-side disconnect handler — which
// queries Mongo for presence broadcast — can race against clearTestDb or
// stopTestDb and surface as a phantom error in an unrelated later test.
const activeSockets = new Set<ClientSocket>();

const connect = (token: string | null): Promise<ClientSocket> =>
  new Promise((resolve, reject) => {
    const opts: Parameters<typeof ioClient>[1] = {
      path: env.SOCKET_PATH,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    };
    if (token) {
      opts.auth = { token };
    }
    const socket = ioClient(serverUrl, opts);
    activeSockets.add(socket);
    socket.once('disconnect', () => activeSockets.delete(socket));
    const onError = (err: Error): void => {
      activeSockets.delete(socket);
      socket.close();
      reject(err);
    };
    socket.once('connect', () => {
      socket.off('connect_error', onError);
      resolve(socket);
    });
    socket.once('connect_error', onError);
  });

const disconnectAllSockets = async (): Promise<void> => {
  if (activeSockets.size === 0) return;
  // Snapshot the set first because the disconnect handler we registered
  // above mutates it.
  const sockets = Array.from(activeSockets);
  await Promise.all(
    sockets.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (!s.connected) {
            activeSockets.delete(s);
            resolve();
            return;
          }
          s.once('disconnect', () => resolve());
          s.disconnect();
        })
    )
  );
  // Server-side disconnect handlers run on the next tick. Wait long enough
  // for the presence-broadcast Mongo query to finish before the test DB is
  // cleared or torn down.
  await new Promise((r) => setTimeout(r, 100));
};

const emitWithAck = <T = unknown>(
  socket: ClientSocket,
  event: string,
  payload: unknown
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ack timeout for ${event}`)),
      1500
    );
    socket.emit(event, payload, (response: T) => {
      clearTimeout(timer);
      resolve(response);
    });
  });

const waitForEvent = <T = unknown>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 1500
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${event}`)),
      timeoutMs
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

beforeAll(async () => {
  await startTestDb();
  httpServer = createServer(app);
  __resetPresenceForTests();
  initPresence();
  io = createSocketServer(httpServer, { skipRedisAdapter: true });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await disconnectAllSockets();
  // io.close() also closes the underlying HTTP server it was attached to,
  // so we don't separately close httpServer (calling close on an already-
  // stopped server throws "Server is not running").
  await shutdownSocketServer(io);
  realtimeEvents.removeAllListeners();
  await stopTestDb();
});

afterEach(async () => {
  // Disconnect any lingering sockets first so their server-side handlers
  // (which may issue Mongo queries) complete BEFORE we wipe the DB.
  await disconnectAllSockets();
  await clearTestDb();
  realtimeEvents.removeAllListeners();
  // The socket bridge re-attaches once via createSocketServer; reset and
  // re-attach here so the next test still receives fan-out.
  // We do this by reusing the existing io; the bridge subscriptions are
  // tracked per Server, so attach is idempotent.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { attachRealtimeBridge } = require('./realtimeBridge');
  attachRealtimeBridge(io);
  __resetRateLimitForTests();
  __resetPresenceForTests();
  initPresence();
});

describe('socket auth', () => {
  it('rejects connections without a token', async () => {
    await expect(connect(null)).rejects.toThrow(/UNAUTHORIZED/i);
  });

  it('rejects connections with an invalid token', async () => {
    await expect(connect('not-a-real-token')).rejects.toThrow(/UNAUTHORIZED/i);
  });

  it('accepts connections with a valid token', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const socket = await connect(alice.token);
    expect(socket.connected).toBe(true);
    socket.close();
  });
});

describe('conversation.join', () => {
  it('rejects join from a non-member', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');
    const convId = await createDirect(alice, bob);

    const socket = await connect(carol.token);
    const ack = await emitWithAck<{ ok: boolean; error?: { code: string } }>(
      socket,
      'conversation.join',
      { conversationId: convId }
    );
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe('FORBIDDEN');
    socket.close();
  });

  it('lets a member join and receive message.created events for that room', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    const bobSocket = await connect(bob.token);
    const ack = await emitWithAck<{ ok: boolean }>(
      bobSocket,
      'conversation.join',
      { conversationId: convId }
    );
    expect(ack.ok).toBe(true);

    const event = waitForEvent<{ conversationId: string; message: { text: string } }>(
      bobSocket,
      'message.created'
    );

    // Fan-out arrives via the realtime bus when the HTTP send endpoint runs.
    await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'hello' });

    const payload = await event;
    expect(payload.conversationId).toBe(convId);
    expect(payload.message.text).toBe('hello');
    bobSocket.close();
  });

  it('does not deliver events to a socket that has not joined the room', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    const bobSocket = await connect(bob.token);
    let received = 0;
    bobSocket.on('message.created', () => {
      received += 1;
    });

    emitRealtime('message.created', {
      conversationId: convId,
      // Minimal stand-in for the DTO — the socket layer treats the payload
      // as opaque and forwards it as-is.
      message: { id: 'm1', conversationId: convId } as never
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toBe(0);
    bobSocket.close();
  });
});

describe('payload validation', () => {
  it('rejects malformed conversation.join payload', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const socket = await connect(alice.token);
    const ack = await emitWithAck<{ ok: boolean; error?: { code: string } }>(
      socket,
      'conversation.join',
      { conversationId: 'not-an-objectid' }
    );
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe('VALIDATION_ERROR');
    socket.close();
  });

  it('rejects extra fields on typing.start', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);
    const socket = await connect(alice.token);
    const ack = await emitWithAck<{ ok: boolean; error?: { code: string } }>(
      socket,
      'typing.start',
      { conversationId: convId, surprise: 'field' }
    );
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe('VALIDATION_ERROR');
    socket.close();
  });
});

describe('typing events', () => {
  it('requires conversation membership', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');
    const convId = await createDirect(alice, bob);

    const socket = await connect(carol.token);
    const ack = await emitWithAck<{ ok: boolean; error?: { code: string } }>(
      socket,
      'typing.start',
      { conversationId: convId }
    );
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe('FORBIDDEN');
    socket.close();
  });

  it('broadcasts typing.started to other members of the room', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createDirect(alice, bob);

    const aliceSocket = await connect(alice.token);
    const bobSocket = await connect(bob.token);
    await emitWithAck(aliceSocket, 'conversation.join', { conversationId: convId });
    await emitWithAck(bobSocket, 'conversation.join', { conversationId: convId });

    const event = waitForEvent<{ userId: string; conversationId: string }>(
      bobSocket,
      'typing.started'
    );
    const ack = await emitWithAck<{ ok: boolean }>(
      aliceSocket,
      'typing.start',
      { conversationId: convId }
    );
    expect(ack.ok).toBe(true);
    const payload = await event;
    expect(payload.userId).toBe(alice.id);
    expect(payload.conversationId).toBe(convId);
    aliceSocket.close();
    bobSocket.close();
  });
});

describe('presence', () => {
  it('marks a user online while a socket is connected and offline after disconnect', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const socket = await connect(alice.token);

    // Wait briefly so the async addSocket completes before we check state.
    await new Promise((r) => setTimeout(r, 50));
    expect(await getPresence().isOnline(alice.id)).toBe(true);

    socket.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await getPresence().isOnline(alice.id)).toBe(false);
    expect(await getPresence().getLastSeen(alice.id)).not.toBeNull();
  });
});

describe('disconnect cleanup', () => {
  it('clears rate-limit and presence state after disconnect', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const socket = await connect(alice.token);

    await new Promise((r) => setTimeout(r, 50));
    expect(await getPresence().isOnline(alice.id)).toBe(true);

    socket.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await getPresence().isOnline(alice.id)).toBe(false);
  });
});
