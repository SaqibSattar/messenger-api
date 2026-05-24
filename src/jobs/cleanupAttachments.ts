import { logger } from '../utils/logger';
import { cleanupOrphanedAttachments } from '../modules/media/media.service';

interface SchedulerHandle {
  stop: () => void;
}

/**
 * Periodic sweep over pending attachments whose upload URL was issued but
 * never completed. The TTL is configured by MEDIA_PENDING_TTL_SECONDS; this
 * loop just keeps calling the idempotent worker on a timer.
 *
 * The worker handles concurrency by guarding each per-doc update with a
 * status filter, so running this loop on multiple processes is safe.
 */
export const startCleanupAttachmentsScheduler = (
  intervalMs: number
): SchedulerHandle => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await cleanupOrphanedAttachments();
    } catch (err) {
      logger.error({ err }, 'cleanupAttachments: sweep failed');
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
