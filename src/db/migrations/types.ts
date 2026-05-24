// Migration shape. Each migration owns:
//   - a stable `name` (used as the idempotency key in the migrations
//     collection — never rename a name once shipped)
//   - a `description` for operator clarity
//   - an idempotent `up()` that may run multiple times without corrupting
//     data. Down migrations are intentionally not modeled: prompt 12
//     rules out destructive migrations without explicit approval, and a
//     scripted rollback would be the most common path to that mistake.
//     If a rollback is needed it must be authored as a new forward
//     migration with the inverse effect.
export interface Migration {
  name: string;
  description: string;
  up: () => Promise<void>;
}

// One row per applied migration. The (name) unique index is what makes
// re-running the runner safe.
export interface MigrationRecordShape {
  name: string;
  appliedAt: Date;
  // Wall-clock duration the up() took on the run that recorded the row.
  // Useful when investigating a slow migration after the fact.
  durationMs: number;
}
