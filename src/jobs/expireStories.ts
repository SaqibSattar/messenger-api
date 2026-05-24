import { logger } from '../utils/logger';
import { expireStoriesOnce } from '../modules/stories/story.service';

interface SchedulerHandle {
  stop: () => void;
}

/**
 * Periodic sweep that marks stories whose `expiresAt` has passed as deleted
 * (with `deletionReason: 'expired'`). The worker is idempotent: per-doc
 * updates are guarded so two parallel runs cannot double-redact, and the
 * underlying partial index keeps already-deleted docs out of subsequent
 * scans.
 *
 * The loop is best-effort — a failed sweep does not crash the process; the
 * next tick picks up where this one left off.
 */
export const startExpireStoriesScheduler = (
  intervalMs: number
): SchedulerHandle => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await expireStoriesOnce();
    } catch (err) {
      logger.error({ err }, 'expireStories: sweep failed');
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
