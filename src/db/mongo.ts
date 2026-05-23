import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let connected = false;

export const connectMongo = async (): Promise<void> => {
  if (!env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured');
  }
  if (connected) return;

  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000
  });

  connected = true;
  logger.info('MongoDB connected');

  mongoose.connection.on('disconnected', () => {
    connected = false;
    logger.warn('MongoDB disconnected');
  });
  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });
};

export const disconnectMongo = async (): Promise<void> => {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
};

export const isMongoReady = (): boolean =>
  connected && mongoose.connection.readyState === 1;
