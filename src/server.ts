import { createServer } from 'node:http';
import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { connectMongo, disconnectMongo } from './db/mongo';
import { connectRedis, disconnectRedis } from './db/redis';
import { createSocketServer, shutdownSocketServer } from './sockets';

const start = async (): Promise<void> => {
  const app = buildApp();

  if (env.MONGODB_URI) {
    await connectMongo();
  } else {
    logger.warn('MONGODB_URI not set — skipping Mongo connection');
  }

  if (env.REDIS_URL) {
    await connectRedis();
  } else {
    logger.warn('REDIS_URL not set — skipping Redis connection');
  }

  // Wrap Express in an http.Server so Socket.IO can attach to the same
  // listener. Without this, sockets would need a second port (and a second
  // health endpoint, second CORS config, ...). One port keeps ops simple.
  const httpServer = createServer(app);
  const io = createSocketServer(httpServer);

  httpServer.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, socketPath: env.SOCKET_PATH },
      'Server listening'
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutdown signal received');
    void (async () => {
      try {
        // Close socket server first so new events stop arriving while we
        // drain the HTTP listener.
        await shutdownSocketServer(io);
      } catch (err) {
        logger.error({ err }, 'Socket shutdown failed');
      }
      httpServer.close(() => {
        void (async () => {
          await disconnectMongo();
          await disconnectRedis();
          process.exit(0);
        })();
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
