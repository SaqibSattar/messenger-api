import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { getRedis, isRedisReady } from '../db/redis';
import {
  socketAuthMiddleware,
  type AppServer,
  type AppSocket
} from './auth';
import { registerSocketHandlers } from './handlers';
import { attachRealtimeBridge, detachRealtimeBridge } from './realtimeBridge';
import { initPresence } from './presence';

export interface SocketBootstrapOptions {
  // Test override — production never passes this.
  skipRedisAdapter?: boolean;
}

export const createSocketServer = (
  httpServer: HttpServer,
  options: SocketBootstrapOptions = {}
): AppServer => {
  const serverOpts: Partial<ServerOptions> = {
    path: env.SOCKET_PATH,
    serveClient: false,
    cors: {
      origin: env.corsOrigins,
      credentials: true
    }
  };

  const io: AppServer = new IOServer(httpServer, serverOpts);

  // Horizontal scaling: when Redis is ready, install the pub/sub adapter so
  // emits from one instance reach sockets connected to other instances. In
  // dev/test without Redis we fall back to the in-process adapter, which
  // still works for single-instance flows.
  if (!options.skipRedisAdapter && isRedisReady()) {
    try {
      const pub = getRedis().duplicate();
      const sub = getRedis().duplicate();
      io.adapter(createAdapter(pub, sub));
      logger.info('Socket.IO Redis adapter attached');
    } catch (err) {
      logger.error({ err }, 'Failed to attach Redis adapter — falling back');
    }
  } else {
    logger.warn('Socket.IO running without Redis adapter (single-instance mode)');
  }

  initPresence();

  io.use(socketAuthMiddleware);

  io.on('connection', (socket: AppSocket) => {
    registerSocketHandlers(io, socket);
  });

  attachRealtimeBridge(io);

  return io;
};

export const shutdownSocketServer = async (io: AppServer): Promise<void> => {
  detachRealtimeBridge(io);
  // Forcibly disconnect every still-connected socket before closing. Without
  // this, idle keep-alive connections can keep the underlying http server
  // bound to its port and io.close() never resolves — manifesting as test
  // teardown hangs or as the next test seeing "socket hang up".
  io.disconnectSockets(true);
  await new Promise<void>((resolve) => {
    io.close(() => resolve());
  });
};
