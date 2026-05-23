import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let client: Redis | null = null;
let ready = false;

export const connectRedis = async (): Promise<Redis> => {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is not configured');
  }
  if (client) return client;

  client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true
  });

  client.on('ready', () => {
    ready = true;
    logger.info('Redis ready');
  });
  client.on('end', () => {
    ready = false;
    logger.warn('Redis connection ended');
  });
  client.on('error', (err) => {
    logger.error({ err }, 'Redis error');
  });

  await client.connect();
  return client;
};

export const getRedis = (): Redis => {
  if (!client) {
    throw new Error('Redis not initialized — call connectRedis() first');
  }
  return client;
};

export const disconnectRedis = async (): Promise<void> => {
  if (!client) return;
  await client.quit();
  client = null;
  ready = false;
};

export const isRedisReady = (): boolean => ready && client !== null;
