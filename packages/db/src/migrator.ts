import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import type { DB } from './types.js';

/**
 * Build a Kysely `Migrator` over `src/migrations` for a given connection.
 * Shared by the `pnpm migrate` CLI (`migrate.ts`) and integration tests that
 * need to migrate the test database before exercising real SQL.
 */
export function createMigrator(db: Kysely<DB>): Migrator {
  const migrationFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
}
