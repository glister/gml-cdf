import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { db, pool } from './client.js';

/**
 * Run all pending migrations to latest. Invoked via `pnpm migrate`
 * (`tsx --env-file ../../.env src/migrate.ts`). Standalone DB CLI — logs to the
 * console since it must run without the built `@repo/logging` artifact present.
 */
async function migrateToLatest(): Promise<void> {
  const migrationFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });

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
