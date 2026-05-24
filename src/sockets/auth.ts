import type { Server, Socket } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import { verifyAccessToken } from '../utils/jwt';
import { User } from '../modules/users/user.model';
import { USER_STATUS } from '../modules/users/user.types';
import {
  resolveEffectivePermissions,
  type Permission,
  type Role
} from '../modules/permissions/permissions.constants';
import { logger } from '../utils/logger';

// The authenticated principal attached to every Socket. Mirrors the shape
// `req.user` carries on the HTTP side so service-layer helpers
// (assertConversationMembership, etc.) work without translation.
export interface SocketUser {
  id: string;
  role: Role;
  permissions: readonly Permission[];
}

export interface SocketData {
  user: SocketUser;
}

// Typed Socket.IO Server / Socket aliases. Events are intentionally kept
// untyped (DefaultEventsMap) — the codebase validates payloads at the handler
// boundary with Zod, and a full typed event map would add a lot of surface
// area for little gain right now. We only type `data` so `socket.data.user`
// is reliable everywhere.
export type AppServer = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
export type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

// Extract a bearer token from the handshake. Preferred location is
// `auth.token` (set by socket.io-client's `auth: { token }`); we also accept
// the Authorization header for parity with HTTP clients. Query strings are
// not accepted — tokens in URLs end up in proxy logs.
const extractToken = (socket: AppSocket): string | null => {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (auth && typeof auth.token === 'string' && auth.token.trim().length > 0) {
    return auth.token.trim();
  }
  const header = socket.handshake.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token.length > 0) return token;
  }
  return null;
};

// Socket.IO middleware. Verifies the access token, loads the user, and
// attaches a SocketUser to `socket.data`. Any failure rejects the connection
// — clients see `connect_error` and never enter the namespace.
export const socketAuthMiddleware = async (
  socket: AppSocket,
  next: (err?: Error) => void
): Promise<void> => {
  const token = extractToken(socket);
  if (!token) {
    next(new Error('UNAUTHORIZED'));
    return;
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    next(new Error('UNAUTHORIZED'));
    return;
  }

  try {
    const user = await User.findById(payload.sub).select('+passwordChangedAt');
    if (!user || user.status !== USER_STATUS.ACTIVE) {
      next(new Error('UNAUTHORIZED'));
      return;
    }

    // Same password-rotation check as the HTTP middleware: a token issued
    // before the user's most recent password change is no longer trusted.
    if (
      user.passwordChangedAt &&
      typeof payload.iat === 'number' &&
      payload.iat * 1000 < user.passwordChangedAt.getTime()
    ) {
      next(new Error('UNAUTHORIZED'));
      return;
    }

    const role = user.role as Role;
    socket.data.user = {
      id: user._id.toString(),
      role,
      permissions: resolveEffectivePermissions(role, user.customPermissions)
    };
    next();
  } catch (err) {
    logger.error({ err }, 'Socket auth failed');
    next(new Error('UNAUTHORIZED'));
  }
};
