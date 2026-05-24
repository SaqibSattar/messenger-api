import { logger } from '../utils/logger';
import { finalizeAccountDeletionsOnce } from '../modules/privacy/accountLifecycle.service';

interface SchedulerHandle {
  stop: () => void;
}

/**
 * Periodic sweep that turns elapsed delete-requests into anonymized DELETED
 * accounts. The underlying worker is idempotent — every per-user transition
 * is guarded by a `status: pending_deletion` filter, so running the loop on
 * multiple processes never double-finalizes a row.
 *
 * The sweep is intentionally not driven by Mongo change streams: the heavy
 * lifting is happening in the cleanup transition (cascading deletes across
 * ~10 collections), which is fine to run on a timer and trivial to scale by
 * adding worker processes.
 */
export const startFinalizeAccountDeletionsScheduler = (
  intervalMs: number
): SchedulerHandle => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await finalizeAccountDeletionsOnce();
      if (result.finalized > 0) {
        logger.info(
          { job: 'finalize-account-deletions', ...result },
          'finalizeAccountDeletions: sweep complete'
        );
      }
    } catch (err) {
      logger.error(
        { err, job: 'finalize-account-deletions' },
        'finalizeAccountDeletions: sweep failed'
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
