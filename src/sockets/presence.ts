import type Redis from 'ioredis';
import { env } from '../config/env';
import { getRedis, isRedisReady } from '../db/redis';

// Presence has two backends behind a common interface:
//
//   - Redis-backed (production / dev with Redis). Active socket ids per user
//     live in a set, and a `lastSeen` key keeps the most recent timestamp.
//     A TTL on both keys means a crashed instance's presence eventually
//     decays even if we never see the disconnect.
//
//   - In-memory (tests, or development without Redis). Same contract,
//     scoped to the current process. Safe because tests never span
//     multiple instances.
//
// Callers use `getPresence()` and never branch on which one is active.

export interface PresenceStore {
  addSocket(userId: string, socketId: string): Promise<{ wasOffline: boolean }>;
  removeSocket(
    userId: string,
    socketId: string
  ): Promise<{ wentOffline: boolean }>;
  refresh(userId: string): Promise<void>;
  isOnline(userId: string): Promise<boolean>;
  getLastSeen(userId: string): Promise<string | null>;
}

const socketsKey = (userId: string): string => `presence:user:${userId}:sockets`;
const lastSeenKey = (userId: string): string =>
  `presence:user:${userId}:lastSeen`;

class RedisPresenceStore implements PresenceStore {
  constructor(private readonly client: Redis, private readonly ttl: number) {}

  async addSocket(
    userId: string,
    socketId: string
  ): Promise<{ wasOffline: boolean }> {
    const key = socketsKey(userId);
    const before = await this.client.scard(key);
    const pipeline = this.client.multi();
    pipeline.sadd(key, socketId);
    pipeline.expire(key, this.ttl);
    pipeline.set(lastSeenKey(userId), new Date().toISOString(), 'EX', this.ttl);
    await pipeline.exec();
    return { wasOffline: before === 0 };
  }

  async removeSocket(
    userId: string,
    socketId: string
  ): Promise<{ wentOffline: boolean }> {
    const key = socketsKey(userId);
    const pipeline = this.client.multi();
    pipeline.srem(key, socketId);
    pipeline.scard(key);
    const result = await pipeline.exec();
    const remaining = (result?.[1]?.[1] as number) ?? 0;
    if (remaining === 0) {
      // Stamp lastSeen with extended TTL so it survives long enough for
      // clients reconnecting in a few seconds to read it.
      await this.client.set(
        lastSeenKey(userId),
        new Date().toISOString(),
        'EX',
        this.ttl * 4
      );
      return { wentOffline: true };
    }
    return { wentOffline: false };
  }

  async refresh(userId: string): Promise<void> {
    const key = socketsKey(userId);
    const count = await this.client.scard(key);
    if (count === 0) return;
    const pipeline = this.client.multi();
    pipeline.expire(key, this.ttl);
    pipeline.set(lastSeenKey(userId), new Date().toISOString(), 'EX', this.ttl);
    await pipeline.exec();
  }

  async isOnline(userId: string): Promise<boolean> {
    const count = await this.client.scard(socketsKey(userId));
    return count > 0;
  }

  async getLastSeen(userId: string): Promise<string | null> {
    return this.client.get(lastSeenKey(userId));
  }
}

class InMemoryPresenceStore implements PresenceStore {
  private readonly sockets = new Map<string, Set<string>>();
  private readonly lastSeen = new Map<string, string>();

  async addSocket(
    userId: string,
    socketId: string
  ): Promise<{ wasOffline: boolean }> {
    let set = this.sockets.get(userId);
    const wasOffline = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socketId);
    this.lastSeen.set(userId, new Date().toISOString());
    return { wasOffline };
  }

  async removeSocket(
    userId: string,
    socketId: string
  ): Promise<{ wentOffline: boolean }> {
    const set = this.sockets.get(userId);
    if (!set) return { wentOffline: false };
    set.delete(socketId);
    if (set.size === 0) {
      this.sockets.delete(userId);
      this.lastSeen.set(userId, new Date().toISOString());
      return { wentOffline: true };
    }
    return { wentOffline: false };
  }

  async refresh(userId: string): Promise<void> {
    if (this.sockets.has(userId)) {
      this.lastSeen.set(userId, new Date().toISOString());
    }
  }

  async isOnline(userId: string): Promise<boolean> {
    const set = this.sockets.get(userId);
    return set !== undefined && set.size > 0;
  }

  async getLastSeen(userId: string): Promise<string | null> {
    return this.lastSeen.get(userId) ?? null;
  }
}

let store: PresenceStore | null = null;

export const initPresence = (override?: PresenceStore): PresenceStore => {
  if (override) {
    store = override;
    return store;
  }
  if (isRedisReady()) {
    store = new RedisPresenceStore(getRedis(), env.PRESENCE_TTL_SECONDS);
  } else {
    store = new InMemoryPresenceStore();
  }
  return store;
};

export const getPresence = (): PresenceStore => {
  if (!store) {
    store = new InMemoryPresenceStore();
  }
  return store;
};

// Test-only reset hook. Production code never calls this — presence is
// initialized once at socket bootstrap time.
export const __resetPresenceForTests = (): void => {
  store = null;
};
