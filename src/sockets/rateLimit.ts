// Lightweight in-memory sliding-window limiter for noisy socket events. The
// spec calls out typing events specifically: a misbehaving or hostile client
// must not be able to spam typing.start/stop and have us fan them out.
//
// Scoped per (socketId, eventName). When the socket disconnects the entry
// is dropped — see release(). For multi-instance scaling the bound still
// applies per-socket, which is the property we actually care about: there
// is no way for one client to exceed it just by spreading load across nodes.

interface Bucket {
  windowStart: number;
  count: number;
}

const WINDOW_MS = 60_000;

const buckets = new Map<string, Bucket>();

const keyOf = (socketId: string, event: string): string =>
  `${socketId}::${event}`;

export const allow = (
  socketId: string,
  event: string,
  limit: number,
  now: number = Date.now()
): boolean => {
  const key = keyOf(socketId, event);
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
};

export const release = (socketId: string): void => {
  // O(n) over buckets — fine in practice because n is bounded by
  // (connected sockets) × (rate-limited event names), both small.
  for (const k of buckets.keys()) {
    if (k.startsWith(`${socketId}::`)) buckets.delete(k);
  }
};

export const __resetRateLimitForTests = (): void => {
  buckets.clear();
};
