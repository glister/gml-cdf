import { Client } from 'pg';

/**
 * Vitest setup file (runs after `setup-env.ts`): ensure the target
 * `POSTGRES_DB` exists, creating it via the `postgres` maintenance database if
 * missing. Used by `dbIntegrationConfig` so each package's integration suite
 * owns a **separate** test database — turbo runs packages' `test` tasks
 * concurrently, and they would otherwise collide on one shared `cdf_test` (row
 * wipes via `truncateAll`, and `@repo/db`'s destructive migration round-trip).
 *
 * `POSTGRES_DB` is set by `dbIntegrationConfig` via `test.env` (applied before
 * setup files); the remaining `POSTGRES_*` creds are loaded from `.env.test` by
 * `setup-env.ts` (an earlier setup file). Idempotent: a duplicate-database error
 * (SQLSTATE 42P04) means another test file already created it.
 */
/* eslint-disable @repo/no-process-env -- test bootstrap; POSTGRES_* come from .env.test */
const database = process.env.POSTGRES_DB;
const host = process.env.POSTGRES_HOST;
const port = process.env.POSTGRES_PORT;
const user = process.env.POSTGRES_USER;
const password = process.env.POSTGRES_PASSWORD;
/* eslint-enable @repo/no-process-env */

if (database && database !== 'postgres' && host && port && user) {
  const admin = new Client({
    host,
    port: Number(port),
    user,
    password,
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
  } catch (error) {
    if ((error as { code?: string }).code !== '42P04') throw error; // 42P04 = duplicate_database
  } finally {
    await admin.end();
  }
}
