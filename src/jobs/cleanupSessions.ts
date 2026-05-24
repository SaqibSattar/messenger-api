import { logger } from '../utils/logger';
import { Session } from '../modules/sessions/session.model';
import {
  CLEANUP_BATCH_SIZE,
  REVOKED_SESSION_RETENTION_SECONDS
} from '../modules/privacy/privacy.types';

interface SchedulerHandle {
  stop: () => void;
}

export interface CleanupSessionsResult {
  removed: number;
}

/**
 * Delete sessions that were revoked more than the retention window ago.
 *
 * Active sessions are already bounded by the TTL index on `expiresAt` — once
 * a refresh token's expiry passes, Mongo removes the document for free. The
 * piece that index doesn't cover is "revoked but not-yet-expired" sessions:
 * a logout immediately revokes the row but `expiresAt` may still be days
 * out, so without this sweep the rows would linger past their useful audit
 * window.
 *
 * Why bother keeping them at all? Until the retention cutoff, a user
 * reviewing their security log wants to see "signed out 2 days ago from
 * Pixel 7, IP X". After the cutoff that detail is just storage cost.
 */
export const cleanupSessionsOnce = async (
  now: Date = new Date(),
  retentionSeconds: number = REVOKED_SESSION_RETENTION_SECONDS,
  batchSize: number = CLEANUP_BATCH_SIZE
): Promise<CleanupSessionsResult> => {
  const cutoff = new Date(now.getTime() - retentionSeconds * 1000);
  const candidates = await Session.find({
    revokedAt: { $lt: cutoff }
  })
    .select('_id')
    .limit(batchSize);
  if (candidates.length === 0) return { removed: 0 };
  const res = await Session.deleteMany({
    _id: { $in: candidates.map((d) => d._id) }
  });
  return { removed: res.deletedCount ?? 0 };
};

export const startCleanupSessionsScheduler = (
  intervalMs: number
): SchedulerHandle => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await cleanupSessionsOnce();
      if (result.removed > 0) {
        logger.info(
          { job: 'cleanup-sessions', ...result },
          'cleanupSessions: sweep complete'
        );
      }
    } catch (err) {
      logger.error(
        { err, job: 'cleanup-sessions' },
        'cleanupSessions: sweep failed'
      );
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);
  return {
    stop: (): void => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
};
