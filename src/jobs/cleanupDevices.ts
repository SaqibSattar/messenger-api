import { logger } from '../utils/logger';
import { cleanupStaleDevices } from '../modules/devices/device.service';

interface SchedulerHandle {
  stop: () => void;
}

/**
 * Periodic sweep for stale device tokens.
 *
 * Devices that haven't checked in for `DEVICE_STALE_AFTER_DAYS` (default 90)
 * are unlikely to have a valid upstream push token any longer. We drop them
 * outright so the push worker stops fanning out to dead transports and the
 * unique-token index frees up for re-registrations.
 *
 * The worker is idempotent — running it on multiple processes only drops the
 * same set of rows once, since each row's deletion is independently atomic.
 */
export const startCleanupDevicesScheduler = (
  intervalMs: number
): SchedulerHandle => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await cleanupStaleDevices();
      if (result.removed > 0) {
        logger.info(
          { job: 'cleanup-devices', ...result },
          'cleanupDevices: sweep complete'
        );
      }
    } catch (err) {
      logger.error({ err, job: 'cleanup-devices' }, 'cleanupDevices: sweep failed');
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
