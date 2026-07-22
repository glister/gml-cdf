import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db } from './client.js';
import { createMigrator } from './migrator.js';

/**
 * Real-Postgres validation of the foundations migrations (core plan 01 §10):
 * the module schemas and convention functions exist after `migrateToLatest`,
 * and the two foundation migrations round-trip cleanly down and back up.
 * Runs against `cdf_test`.
 */

async function schemaExists(name: string): Promise<boolean> {
  const r = await sql<{
    c: number;
  }>`select count(*)::int as c from information_schema.schemata where schema_name = ${name}`.execute(
    db,
  );
  return r.rows[0].c > 0;
}

async function platformFunctionExists(name: string): Promise<boolean> {
  const r = await sql<{ c: number }>`
    select count(*)::int as c
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform' and p.proname = ${name}
  `.execute(db);
  return r.rows[0].c > 0;
}

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  // Leave the database fully migrated regardless of the round-trip test.
  await createMigrator(db).migrateToLatest();
  await db.destroy();
});

describe('foundations migrations', () => {
  it('creates the platform and hr schemas', async () => {
    expect(await schemaExists('platform')).toBe(true);
    expect(await schemaExists('hr')).toBe(true);
  });

  it('creates the two convention trigger functions in platform', async () => {
    expect(await platformFunctionExists('append_only_guard')).toBe(true);
    expect(await platformFunctionExists('set_updated_at')).toBe(true);
  });

  it('round-trips the two foundation migrations down and back up cleanly', async () => {
    const migrator = createMigrator(db);

    const down1 = await migrator.migrateDown();
    expect(down1.error).toBeUndefined();
    expect(down1.results?.[0]?.migrationName).toBe('20260707T100100-convention-functions');

    const down2 = await migrator.migrateDown();
    expect(down2.error).toBeUndefined();
    expect(down2.results?.[0]?.migrationName).toBe('20260707T100000-module-schemas');

    // Both are gone (auth-tables in public remains untouched below the two).
    expect(await schemaExists('platform')).toBe(false);
    expect(await schemaExists('hr')).toBe(false);

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    expect(await schemaExists('platform')).toBe(true);
    expect(await schemaExists('hr')).toBe(true);
    expect(await platformFunctionExists('append_only_guard')).toBe(true);
    expect(await platformFunctionExists('set_updated_at')).toBe(true);
  });
});
