import { logger } from '../utils/logger';
import { InviteLink } from '../modules/invites/inviteLink.model';
import {
  CLEANUP_BATCH_SIZE,
  INVITE_RETENTION_SECONDS
} from '../modules/privacy/privacy.types';

interface SchedulerHandle {
  stop: () => void;
}

export interface CleanupInvitesResult {
  removed: number;
}

/**
 * Hard-delete invite links that have been revoked OR have passed their
 * `expiresAt` for longer than the retention window.
 *
 * Why not a Mongo TTL index? Admins frequently want to see expired/revoked
 * links for a short audit window after they stop working. The retention
 * delay (default 30 days) lets a member who reports "I clicked a link and it
 * said expired" file a question that admins can still answer.
 */
export const cleanupInvitesOnce = async (
  now: Date = new Date(),
  retentionSeconds: number = INVITE_RETENTION_SECONDS,
  batchSize: number = CLEANUP_BATCH_SIZE
): Promise<CleanupInvitesResult> => {
  const cutoff = new Date(now.getTime() - retentionSeconds * 1000);
  const candidates = await InviteLink.find({
    $or: [
      { revokedAt: { $lt: cutoff } },
      // Already-expired-and-stale: expiresAt itself is in the past by at
      // least the retention window. We don't drop invites whose maxUses
      // counter is exhausted but haven't expired yet — leaving them in the
      // collection lets us answer "why did Bob's link stop working".
      { expiresAt: { $lt: cutoff } }
    ]
  })
    .select('_id')
    .limit(batchSize);
  if (candidates.length === 0) return { removed: 0 };
  const res = await InviteLink.deleteMany({
    _id: { $in: candidates.map((d) => d._id) }
  });
  return { removed: res.deletedCount ?? 0 };
};

export const startCleanupInvitesScheduler = (
  intervalMs: number
): SchedulerHandle => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await cleanupInvitesOnce();
      if (result.removed > 0) {
        logger.info(
          { job: 'cleanup-invites', ...result },
          'cleanupInvites: sweep complete'
        );
      }
    } catch (err) {
      logger.error(
        { err, job: 'cleanup-invites' },
        'cleanupInvites: sweep failed'
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
