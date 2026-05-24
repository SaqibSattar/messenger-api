import type { Types } from 'mongoose';
import { emitRealtime } from '../services/realtimeEvents';
import { logger } from '../utils/logger';
import { Message, toMessageDto } from '../modules/messages/message.model';
import {
  DISAPPEARING_CLEANUP_BATCH_SIZE,
  MESSAGE_DELETION_REASON
} from '../modules/messages/message.types';

export interface ExpireMessagesResult {
  scanned: number;
  expired: number;
}

/**
 * Background cleanup pass for disappearing messages.
 *
 * Each call processes up to `batchSize` messages whose `expiresAt` is in the
 * past and which have not been redacted yet. The job is idempotent in two
 * senses:
 *   1. The partial index on `(expiresAt asc) where expiredAt missing` means a
 *      message already processed by a previous run is invisible to subsequent
 *      runs — it cannot be picked up twice.
 *   2. The per-message update uses a guarded filter that only matches when
 *      `expiredAt` is still missing, so a concurrent run on another instance
 *      can race the same message without causing double-redaction.
 *
 * No raw message bodies, attachment paths, or user PII are logged — only the
 * id and counts. That's deliberate: the audit-log module (10) is where
 * detailed history goes; here we only need health telemetry.
 */
export const expireMessagesOnce = async (
  now: Date = new Date(),
  batchSize = DISAPPEARING_CLEANUP_BATCH_SIZE
): Promise<ExpireMessagesResult> => {
  // Read a bounded batch ordered by expiresAt so the oldest are cleared
  // first. We don't use cursors — the filter pulls a fresh window each call
  // and the partial index keeps already-expired docs out of the result.
  const candidates = await Message.find({
    expiresAt: { $lte: now },
    expiredAt: { $exists: false }
  })
    .sort({ expiresAt: 1 })
    .limit(batchSize);

  let expired = 0;

  for (const msg of candidates) {
    // Atomic guard: only redact if nobody else has touched expiredAt yet.
    // findOneAndUpdate with { new: true } returns the post-update doc so the
    // realtime payload reflects the final masked state.
    const updated = await Message.findOneAndUpdate(
      {
        _id: msg._id,
        expiredAt: { $exists: false }
      },
      {
        $set: {
          text: '',
          expiredAt: now,
          // Track expiry as a deletion so existing read-paths (which check
          // deletedAt) and the moderation/audit history pick it up uniformly.
          // Only stamp deletion fields if the message wasn't already
          // user/mod-deleted — that preserves the original reason.
          ...(msg.deletedAt
            ? {}
            : {
                deletedAt: now,
                deletionReason: MESSAGE_DELETION_REASON.EXPIRED
              })
        }
      },
      { new: true }
    );

    if (!updated) continue;
    expired += 1;

    // Emit per-message. Listeners (sockets) will fan out only to the
    // authorized conversation room — that authorization is the socket
    // layer's responsibility, not ours.
    emitRealtime('message.expired', {
      conversationId: updated.conversationId.toString(),
      messageId: (updated._id as Types.ObjectId).toString(),
      message: toMessageDto(updated)
    });
  }

  if (expired > 0) {
    logger.info(
      { scanned: candidates.length, expired },
      'expireMessages: batch complete'
    );
  }

  return { scanned: candidates.length, expired };
};

interface SchedulerHandle {
  stop: () => void;
}

/**
 * Loop helper used by the long-running process. Schedules `expireMessagesOnce`
 * at the given interval. The tests don't use this — they call
 * `expireMessagesOnce` directly so the loop and the work are testable in
 * isolation.
 */
export const startExpireMessagesScheduler = (
  intervalMs: number
): SchedulerHandle => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await expireMessagesOnce();
    } catch (err) {
      // The job is best-effort — a failed sweep should not crash the process.
      logger.error({ err }, 'expireMessages: sweep failed');
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
