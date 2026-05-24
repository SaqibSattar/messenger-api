import { logger } from '../utils/logger';
import { Notification } from '../modules/notifications/notification.model';
import {
  CLEANUP_BATCH_SIZE,
  NOTIFICATION_RETENTION_SECONDS
} from '../modules/privacy/privacy.types';

interface SchedulerHandle {
  stop: () => void;
}

export interface CleanupNotificationsResult {
  removed: number;
}

/**
 * Drop notification rows older than the retention window. A user who has not
 * acknowledged a row in ~3 months almost certainly never will, and the inbox
 * page-size is bounded — older rows are storage cost without product value.
 *
 * Bounded per call so a single tick cannot lock the collection. Re-running
 * the worker (multi-process or after a crash) only removes the same rows
 * once because each `deleteMany` is independently atomic.
 */
export const cleanupNotificationsOnce = async (
  now: Date = new Date(),
  retentionSeconds: number = NOTIFICATION_RETENTION_SECONDS,
  batchSize: number = CLEANUP_BATCH_SIZE
): Promise<CleanupNotificationsResult> => {
  const cutoff = new Date(now.getTime() - retentionSeconds * 1000);
  // Two-step delete: find ids first so the per-tick volume is capped. A
  // plain deleteMany with the same filter would also work but would not
  // honor the batch size — we want a steady, predictable cadence.
  const oldDocs = await Notification.find({ createdAt: { $lt: cutoff } })
    .select('_id')
    .limit(batchSize);
  if (oldDocs.length === 0) return { removed: 0 };
  const res = await Notification.deleteMany({
    _id: { $in: oldDocs.map((d) => d._id) }
  });
  return { removed: res.deletedCount ?? 0 };
};

export const startCleanupNotificationsScheduler = (
  intervalMs: number
): SchedulerHandle => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await cleanupNotificationsOnce();
      if (result.removed > 0) {
        logger.info(
          { job: 'cleanup-notifications', ...result },
          'cleanupNotifications: sweep complete'
        );
      }
    } catch (err) {
      logger.error(
        { err, job: 'cleanup-notifications' },
        'cleanupNotifications: sweep failed'
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
