import mongoose from 'mongoose';
import type { Migration } from './types';

// Apply each model's schema-defined indexes to the connected database.
// Mongoose's syncIndexes() compares the schema definition to the live
// indexes and creates/drops to match. Safe to re-run because the operation
// is convergent — if a target index already exists in the right shape,
// it's a no-op.
//
// Note that this migration imports the application model registry only
// after the runner has loaded the schemas (via `import './models'` in the
// runner). That keeps schema registration in one place and avoids having
// this file enumerate every model by hand — new models added to the app
// are picked up on the next migrate run with no code change here.
const migration: Migration = {
  name: '0001-sync-indexes',
  description:
    'Sync every registered Mongoose model index with the database (create/drop to match schema).',
  up: async (): Promise<void> => {
    const names = mongoose.modelNames();
    for (const name of names) {
      // Skip the MigrationRecord model itself — the runner owns it and
      // syncing it from inside a migration would be circular bookkeeping.
      if (name === 'MigrationRecord') continue;
      const model = mongoose.model(name);
      await model.syncIndexes();
    }
  }
};

export default migration;
