import { faker } from '@faker-js/faker';
import { type Kysely, sql } from 'kysely';
import type { DB } from './types.js';
import type { NewSession, NewUser } from './index.js';

/**
 * Test fixtures for `@repo/db`. Pure factories (no DB connection) plus a
 * `truncateAll` helper for isolating integration tests that run against a real
 * Postgres. Imported as `@repo/db/test-support`.
 */

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
 * ADR-0011) are deliberately **skipped**: they `REVOKE TRUNCATE FROM PUBLIC`, so
 * TRUNCATE would raise. They are discovered by the presence of the
 * `platform.append_only_guard` trigger. Tests that touch append-only tables use
 * per-test scratch rows (and, where they create their own scratch tables, drop
 * them in teardown) rather than relying on `truncateAll`.
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

  await sql`TRUNCATE TABLE ${sql.raw(targets.join(', '))} RESTART IDENTITY CASCADE`.execute(db);
}
