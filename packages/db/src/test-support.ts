import { faker } from '@faker-js/faker';
import { type Kysely, sql } from 'kysely';
import type { DB } from './types.js';
import type { NewSession, NewUser } from './index.js';

/**
 * Test fixtures for `@repo/db`. Pure factories (no DB connection) plus a
 * `truncateAll` helper for isolating integration tests that run against a real
 * Postgres. Imported as `@repo/db/test-support`.
 */

// Re-exported so cross-package integration suites can migrate `cdf_test` to
// latest in `beforeAll` (`createMigrator(db).migrateToLatest()` — idempotent)
// without reaching into `@repo/db` internals. Packages that call this must inline
// `kysely` in their vitest config so `FileMigrationProvider` loads migrations
// through Vite (see `packages/db/vitest.config.ts`).
export { createMigrator } from './migrator.js';

export function makeUser(overrides: Partial<NewUser> = {}): NewUser {
  return {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email().toLowerCase(),
    email_verified: true,
    ...overrides,
  };
}

export function makeSession(userId: string, overrides: Partial<NewSession> = {}): NewSession {
  return {
    id: faker.string.uuid(),
    user_id: userId,
    token: faker.string.alphanumeric(40),
    expires_at: faker.date.future(),
    ...overrides,
  };
}

/**
 * Wipe every mutable base table across `public`, `platform` and `hr` for test
 * isolation. Use in `beforeEach` for integration tests.
 *
 * Append-only tables (journal, ledgers, transitions, signature evidence —
 * ADR-0011) are deliberately **not listed**: they `REVOKE TRUNCATE FROM PUBLIC`
 * and carry a `BEFORE TRUNCATE` guard, so a direct TRUNCATE would raise. They are
 * discovered by the presence of the `platform.append_only_guard` trigger.
 *
 * But a truncatable parent can have append-only children with FKs to it (e.g.
 * `platform.person` → the append-only `person_merge`/`person_flag`), and
 * `TRUNCATE … CASCADE` fires those children's `BEFORE TRUNCATE` guards regardless
 * of row count. So the whole reset runs inside one transaction (to pin a single
 * connection) with `SET LOCAL session_replication_role = 'replica'`, which
 * suppresses user triggers for the statement — letting the cascade wipe those
 * children silently. `SET LOCAL` resets automatically at COMMIT. Append-only
 * tables with no FK path from a listed table (the journal) are untouched; tests
 * that accumulate there use per-test scratch rows.
 */
export async function truncateAll(db: Kysely<DB>): Promise<void> {
  const rows = await sql<{ qualified: string }>`
    SELECT format('%I.%I', t.table_schema, t.table_name) AS qualified
    FROM information_schema.tables t
    WHERE t.table_schema IN ('public', 'platform', 'hr')
      AND t.table_type = 'BASE TABLE'
      AND t.table_name NOT LIKE 'kysely_%'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = tg.tgfoid
        JOIN pg_namespace pn ON pn.oid = p.pronamespace
        WHERE c.relname = t.table_name
          AND n.nspname = t.table_schema
          AND p.proname = 'append_only_guard'
          AND pn.nspname = 'platform'
      )
  `.execute(db);

  const targets = rows.rows.map((r) => r.qualified);
  if (targets.length === 0) return;

  await db.transaction().execute(async (trx) => {
    // Superuser-only; test-role connections are superusers (assumption A3).
    await sql`SET LOCAL session_replication_role = 'replica'`.execute(trx);
    await sql`TRUNCATE TABLE ${sql.raw(targets.join(', '))} RESTART IDENTITY CASCADE`.execute(trx);
  });
}
