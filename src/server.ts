import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { connectMongo, disconnectMongo } from './db/mongo';
import { connectRedis, disconnectRedis } from './db/redis';

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

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server listening');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutdown signal received');
    server.close(() => {
      void (async () => {
        await disconnectMongo();
        await disconnectRedis();
        process.exit(0);
      })();
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
