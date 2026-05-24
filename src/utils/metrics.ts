import { isMongoReady } from '../db/mongo';
import { isRedisReady } from '../db/redis';

export interface ProcessMetrics {
  uptimeSeconds: number;
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    pid: number;
    nodeVersion: string;
  };
  dependencies: {
    mongo: boolean;
    redis: boolean;
  };
}

// Lightweight, privacy-safe operational view. Intentionally returns nothing
// per-user — only process and dependency state. A separate admin-only
// `system-summary` endpoint covers collection sizes / 24h activity.
export const getProcessMetrics = async (): Promise<ProcessMetrics> => {
  const mem = process.memoryUsage();
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    process: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      pid: process.pid,
      nodeVersion: process.version
    },
    dependencies: {
      mongo: isMongoReady(),
      redis: isRedisReady()
    }
  };
};
