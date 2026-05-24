// CLI entry point: `npm run migrate`. Connects to MongoDB, runs every
// pending migration, prints a short summary, then exits.
//
// This script is intentionally thin — the logic lives in
// `src/db/migrations/index.ts` so the same code path is exercised by tests
// and by a programmatic caller (e.g. a future "migrate on startup" hook).

import { connectMongo, disconnectMongo } from './mongo';
import { runMigrations } from './migrations';
import { logger } from '../utils/logger';

const main = async (): Promise<void> => {
  await connectMongo();
  try {
    const results = await runMigrations();
    for (const r of results) {
      logger.info(
        { migration: r.name, status: r.status, durationMs: r.durationMs },
        `migration ${r.status}`
      );
    }
  } finally {
    await disconnectMongo();
  }
};

main().catch((err) => {
  logger.error({ err }, 'migration runner failed');
  // Exit non-zero so CI / deploy pipelines stop on a failed migrate step.
  process.exit(1);
});
