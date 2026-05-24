import mongoose from 'mongoose';
import { logger } from '../../utils/logger';
// Side-effecting import: registers every application model with Mongoose so
// that 0001-sync-indexes can iterate the model registry without the migration
// file needing to know about every collection itself.
import './models';
import { MigrationRecord } from './migrationRecord.model';
import migration0001 from './0001-sync-indexes';
import migration0002 from './0002-backfill-conversation-direct-key';
import type { Migration } from './types';

// Ordered list. New migrations are appended — never reordered, never removed.
// A migration's place in this array does NOT determine whether it has been
// applied (that's the MigrationRecord collection's job); the order only
// controls the sequence of first-time application.
const migrations: Migration[] = [migration0001, migration0002];

export interface MigrationResult {
  name: string;
  status: 'applied' | 'skipped';
  durationMs: number;
}

/**
 * Run every pending migration once, in order. Safe to call on every process
 * start: applied migrations are skipped by their MigrationRecord row, and
 * each individual migration is also independently idempotent.
 *
 * Returns one result per migration, including skipped ones, so the caller
 * can log or assert on the outcome.
 */
export const runMigrations = async (): Promise<MigrationResult[]> => {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('runMigrations: a Mongoose connection must be open');
  }

  // Ensure the MigrationRecord collection's unique index exists before we
  // try to use it as the idempotency lock. Without this the very first run
  // on a fresh database can race two parallel invocations into duplicating
  // a migration's effects.
  await MigrationRecord.syncIndexes();

  const results: MigrationResult[] = [];

  for (const m of migrations) {
    const existing = await MigrationRecord.findOne({ name: m.name });
    if (existing) {
      results.push({ name: m.name, status: 'skipped', durationMs: 0 });
      continue;
    }

    const start = Date.now();
    let durationMs = 0;
    try {
      await m.up();
      durationMs = Date.now() - start;

      // Recording after the up() succeeds means a crashed migration leaves
      // no row and will retry on the next run. The unique index keeps a
      // second concurrent process from double-recording the same name.
      try {
        await MigrationRecord.create({
          name: m.name,
          appliedAt: new Date(),
          durationMs
        });
      } catch (err) {
        if (
          err instanceof mongoose.mongo.MongoServerError &&
          err.code === 11000
        ) {
          // Another process recorded this migration between our `findOne`
          // and our `create`. The up() we just ran was a no-op on the
          // already-converged state (each migration is itself idempotent),
          // so we can safely report success.
          results.push({
            name: m.name,
            status: 'skipped',
            durationMs
          });
          continue;
        }
        throw err;
      }

      results.push({ name: m.name, status: 'applied', durationMs });
    } catch (err) {
      logger.error(
        { err, migration: m.name, durationMs: Date.now() - start },
        'migration failed'
      );
      throw err;
    }
  }

  return results;
};

// Re-exports so tests and the CLI can introspect / assert without reaching
// into the module's internals.
export { migrations };
export { MigrationRecord } from './migrationRecord.model';
