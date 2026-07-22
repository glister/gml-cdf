import { db, pool } from './client.js';
import { createMigrator } from './migrator.js';

/**
 * Run all pending migrations to latest. Invoked via `pnpm migrate`
 * (`tsx --env-file ../../.env src/migrate.ts`). Standalone DB CLI — logs to the
 * console since it must run without the built `@repo/logging` artifact present.
 */
async function migrateToLatest(): Promise<void> {
  const migrator = createMigrator(db);
  const { error, results } = await migrator.migrateToLatest();

  for (const it of results ?? []) {
    if (it.status === 'Success') {
      // eslint-disable-next-line no-console
      console.log(`✔ applied ${it.migrationName}`);
    } else if (it.status === 'Error') {
      // eslint-disable-next-line no-console
      console.error(`✖ failed ${it.migrationName}`);
    }
  }

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Migration failed:', error);
    process.exitCode = 1;
  }

  await db.destroy();
  await pool.end().catch(() => {});
}

void migrateToLatest();
