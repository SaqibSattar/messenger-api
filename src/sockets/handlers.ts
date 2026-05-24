import mongoose, { type Types } from 'mongoose';
import { z, type ZodError } from 'zod';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { ConversationMember } from '../modules/conversations/conversationMember.model';
import { markDelivered, markRead } from '../modules/messages/message.service';
import type { AppServer, AppSocket } from './auth';
import {
  conversationRefSchema,
  messageRefSchema
} from './validation';
import { conversationRoom, userRoom } from './rooms';
import { allow, release } from './rateLimit';
import { getPresence } from './presence';

// Standard ack shape so clients can branch on success cleanly.
type Ack = (response: AckResponse) => void;

type AckResponse =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string; details?: unknown };
    };

const ackOk = (cb?: Ack): void => cb?.({ ok: true });

const ackErr = (
  cb: Ack | undefined,
  code: string,
  message: string,
  details?: unknown
): void => cb?.({ ok: false, error: { code, message, details } });

// Parse helper. Bad payloads never reach the service layer — they get a
// validation ack and the event is dropped.
const parsePayload = <T>(
  schema: z.ZodType<T>,
  payload: unknown,
  cb: Ack | undefined
): T | null => {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const err: ZodError = result.error;
    ackErr(cb, 'VALIDATION_ERROR', 'Invalid payload', err.flatten());
    return null;
  }
  return result.data;
};

const isActiveMember = async (
  conversationId: string,
  userId: string
): Promise<boolean> => {
  const m = await ConversationMember.findOne({
    conversationId: new mongoose.Types.ObjectId(conversationId),
    userId: new mongoose.Types.ObjectId(userId),
    leftAt: { $exists: false }
  })
    .select('_id')
    .lean();
  return m !== null;
};

// ---------------------------------------------------------------------------
// Per-socket event registration
// ---------------------------------------------------------------------------

export const registerSocketHandlers = (io: AppServer, socket: AppSocket): void => {
  const user = socket.data.user;
  const log = logger.child({ socketId: socket.id, userId: user.id });

  // Every authenticated socket joins its user room immediately so server
  // pushes targeted at the user (delivered/read receipts, presence pings)
  // reach all their devices.
  void socket.join(userRoom(user.id));

  // Track which conversation rooms this socket joined. Used on disconnect
  // for symmetric cleanup — Socket.IO leaves rooms automatically, but
  // keeping our own set lets us emit precise observability logs.
  const joinedConversations = new Set<string>();

  // Mark presence and notify counterparts that this user is now online (only
  // on the *first* socket — additional devices do not re-emit).
  //
  // Privacy: presence is fanned out only to conversation rooms the user
  // belongs to, never globally. A user with no shared conversations is
  // invisible to other users, which matches "do not broadcast private data
  // globally" from the spec.
  const presence = getPresence();
  presence
    .addSocket(user.id, socket.id)
    .then(async ({ wasOffline }) => {
      if (!wasOffline) return;
      await broadcastPresence(io, user.id, 'presence.online');
    })
    .catch((err) => log.error({ err }, 'presence.addSocket failed'));

  // -------------------------------------------------------------------------
  // conversation.join
  // -------------------------------------------------------------------------
  socket.on(
    'conversation.join',
    async (payload: unknown, cb?: Ack): Promise<void> => {
      const data = parsePayload(conversationRefSchema, payload, cb);
      if (!data) return;
      try {
        const ok = await isActiveMember(data.conversationId, user.id);
        if (!ok) {
          ackErr(cb, 'FORBIDDEN', 'Not a member of this conversation');
          return;
        }
        await socket.join(conversationRoom(data.conversationId));
        joinedConversations.add(data.conversationId);
        ackOk(cb);
      } catch (err) {
        log.error({ err }, 'conversation.join failed');
        ackErr(cb, 'INTERNAL', 'Could not join conversation');
      }
    }
  );

  // -------------------------------------------------------------------------
  // conversation.leave
  // -------------------------------------------------------------------------
  socket.on(
    'conversation.leave',
    async (payload: unknown, cb?: Ack): Promise<void> => {
      const data = parsePayload(conversationRefSchema, payload, cb);
      if (!data) return;
      await socket.leave(conversationRoom(data.conversationId));
      joinedConversations.delete(data.conversationId);
      ackOk(cb);
    }
  );

  // -------------------------------------------------------------------------
  // typing.start / typing.stop
  // -------------------------------------------------------------------------
  const handleTyping = async (
    payload: unknown,
    cb: Ack | undefined,
    kind: 'start' | 'stop'
  ): Promise<void> => {
    const data = parsePayload(conversationRefSchema, payload, cb);
    if (!data) return;

    if (!allow(socket.id, `typing.${kind}`, env.SOCKET_TYPING_MAX_PER_MINUTE)) {
      ackErr(cb, 'RATE_LIMITED', 'Too many typing events');
      return;
    }

    try {
      const ok = await isActiveMember(data.conversationId, user.id);
      if (!ok) {
        ackErr(cb, 'FORBIDDEN', 'Not a member of this conversation');
        return;
      }

      const event = kind === 'start' ? 'typing.started' : 'typing.stopped';
      // socket.to() broadcasts to everyone in the room *except* the sender —
      // a user does not need to see their own typing echoed back.
      socket
        .to(conversationRoom(data.conversationId))
        .emit(event, {
          conversationId: data.conversationId,
          userId: user.id,
          at: new Date().toISOString()
        });
      ackOk(cb);
    } catch (err) {
      log.error({ err, kind }, 'typing event failed');
      ackErr(cb, 'INTERNAL', 'Could not process typing event');
    }
  };

  socket.on('typing.start', (payload: unknown, cb?: Ack) =>
    void handleTyping(payload, cb, 'start')
  );
  socket.on('typing.stop', (payload: unknown, cb?: Ack) =>
    void handleTyping(payload, cb, 'stop')
  );

  // -------------------------------------------------------------------------
  // message.delivered / message.read
  //
  // Both go through the same service the HTTP API uses, so authorization,
  // ownership checks, and the fan-out via realtimeEvents are identical
  // whether the receipt arrived over HTTP or over the socket.
  // -------------------------------------------------------------------------
  const handleReceipt = async (
    payload: unknown,
    cb: Ack | undefined,
    kind: 'delivered' | 'read'
  ): Promise<void> => {
    const data = parsePayload(messageRefSchema, payload, cb);
    if (!data) return;
    try {
      if (kind === 'delivered') {
        await markDelivered(user, data.messageId);
      } else {
        await markRead(user, data.messageId);
      }
      ackOk(cb);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      const code = (err as { code?: string }).code ?? 'INTERNAL';
      const message = (err as { message?: string }).message ?? 'Failed';
      if (status >= 500) {
        log.error({ err, kind }, 'receipt event failed');
      }
      ackErr(cb, code, message);
    }
  };

  socket.on('message.delivered', (payload: unknown, cb?: Ack) =>
    void handleReceipt(payload, cb, 'delivered')
  );
  socket.on('message.read', (payload: unknown, cb?: Ack) =>
    void handleReceipt(payload, cb, 'read')
  );

  // -------------------------------------------------------------------------
  // presence.ping — keep the user marked online while they're idle but
  // still connected. Refreshing the TTL is enough; we do not re-broadcast
  // presence.online for every ping.
  // -------------------------------------------------------------------------
  socket.on('presence.ping', async (_payload: unknown, cb?: Ack) => {
    try {
      await getPresence().refresh(user.id);
      ackOk(cb);
    } catch (err) {
      log.error({ err }, 'presence.ping failed');
      ackErr(cb, 'INTERNAL', 'Could not refresh presence');
    }
  });

  // -------------------------------------------------------------------------
  // Disconnect cleanup
  // -------------------------------------------------------------------------
  socket.on('disconnect', () => {
    release(socket.id);
    void getPresence()
      .removeSocket(user.id, socket.id)
      .then(async ({ wentOffline }) => {
        if (!wentOffline) return;
        await broadcastPresence(io, user.id, 'presence.offline');
      })
      .catch((err) => log.error({ err }, 'presence.removeSocket failed'));
    if (joinedConversations.size > 0) {
      log.debug(
        { conversationCount: joinedConversations.size },
        'Socket disconnected; conversation rooms released'
      );
    }
  });
};

// Look up the user's active conversation memberships and emit the presence
// event into each conversation room. Recipients on those rooms have already
// proven membership via conversation.join, so they see only counterparts they
// have an existing relationship with.
const broadcastPresence = async (
  io: AppServer,
  userId: string,
  event: 'presence.online' | 'presence.offline'
): Promise<void> => {
  const memberships = await ConversationMember.find({
    userId: new mongoose.Types.ObjectId(userId),
    leftAt: { $exists: false }
  })
    .select('conversationId')
    .lean<Array<{ conversationId: Types.ObjectId }>>();

  const at = new Date().toISOString();
  for (const m of memberships) {
    io.to(conversationRoom(m.conversationId.toString())).emit(event, {
      userId,
      at
    });
  }
};
