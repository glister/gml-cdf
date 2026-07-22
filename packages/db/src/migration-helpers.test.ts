import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db } from './client.js';
import { newUuidV7 } from './ids.js';
import { createMigrator } from './migrator.js';
import {
  attachUpdatedAtTrigger,
  dropAppendOnly,
  makeAppendOnly,
  withStandardColumns,
} from './migration-helpers.js';

/**
 * Real-Postgres validation of the ADR-0011 migration helpers (core plan 01
 * §10). Runs against the test database (`cdf_test`); each test uses its own
 * scratch table in `platform`, dropped in teardown. Mock-DB tests cannot prove
 * trigger/REVOKE behaviour — only executed SQL can (ADR-0004).
 */

async function dropTable(qualified: string): Promise<void> {
  await sql`DROP TABLE IF EXISTS ${sql.table(qualified)} CASCADE`.execute(db);
}

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

describe('withStandardColumns + attachUpdatedAtTrigger', () => {
  const T = 'platform.std_probe';
  afterEach(() => dropTable(T));

  it('adds timestamp defaults, nullable soft-delete and actor stamps', async () => {
    await withStandardColumns(
      db.schema.createTable(T).addColumn('id', 'uuid', (c) => c.primaryKey()),
    ).execute();

    const systemActorRow = newUuidV7();
    const namedActorRow = newUuidV7();
    const actor = newUuidV7();

    // created_by defaults to NULL (system actor); explicit UUID also accepted.
    await sql`insert into ${sql.table(T)} (id) values (${systemActorRow})`.execute(db);
    await sql`insert into ${sql.table(T)} (id, created_by) values (${namedActorRow}, ${actor})`.execute(
      db,
    );

    const rows = await sql<{
      id: string;
      created_at: Date;
      updated_at: Date;
      deleted_at: Date | null;
      created_by: string | null;
    }>`select id, created_at, updated_at, deleted_at, created_by from ${sql.table(T)} order by id`.execute(
      db,
    );

    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    const sys = byId.get(systemActorRow)!;
    const named = byId.get(namedActorRow)!;

    expect(sys.created_at).toBeInstanceOf(Date);
    expect(sys.updated_at).toBeInstanceOf(Date);
    expect(sys.deleted_at).toBeNull();
    expect(sys.created_by).toBeNull();
    expect(named.created_by).toBe(actor);
  });

  it('set_updated_at trigger moves updated_at forward on UPDATE, leaving created_at', async () => {
    await withStandardColumns(
      db.schema.createTable(T).addColumn('id', 'uuid', (c) => c.primaryKey()),
    ).execute();
    await attachUpdatedAtTrigger(db, T);

    const id = newUuidV7();
    await sql`insert into ${sql.table(T)} (id) values (${id})`.execute(db);

    const inserted = (
      await sql<{
        created_at: Date;
        updated_at: Date;
      }>`select created_at, updated_at from ${sql.table(T)} where id = ${id}`.execute(db)
    ).rows[0];

    // The app does NOT set updated_at — the trigger must.
    await sql`update ${sql.table(T)} set created_by = ${newUuidV7()} where id = ${id}`.execute(db);

    const updated = (
      await sql<{
        created_at: Date;
        updated_at: Date;
      }>`select created_at, updated_at from ${sql.table(T)} where id = ${id}`.execute(db)
    ).rows[0];

    expect(updated.updated_at.getTime()).toBeGreaterThan(inserted.updated_at.getTime());
    expect(updated.created_at.getTime()).toBe(inserted.created_at.getTime());
  });
});

describe('makeAppendOnly', () => {
  const T = 'platform.ao_probe';
  const seed = newUuidV7();

  beforeEach(async () => {
    await withStandardColumns(
      db.schema.createTable(T).addColumn('id', 'uuid', (c) => c.primaryKey()),
      { updatedAt: false, softDelete: false, actorStamps: false },
    ).execute();
    await makeAppendOnly(db, T);
    await sql`insert into ${sql.table(T)} (id) values (${seed})`.execute(db);
  });
  afterEach(() => dropTable(T));

  it('allows INSERT but blocks UPDATE, DELETE and TRUNCATE at the database level', async () => {
    // INSERT still works (append is the point).
    await expect(
      sql`insert into ${sql.table(T)} (id) values (${newUuidV7()})`.execute(db),
    ).resolves.toBeDefined();

    await expect(
      sql`update ${sql.table(T)} set created_at = now() where id = ${seed}`.execute(db),
    ).rejects.toThrow(/append-only violation: UPDATE on platform\.ao_probe/);

    await expect(sql`delete from ${sql.table(T)} where id = ${seed}`.execute(db)).rejects.toThrow(
      /append-only violation: DELETE on platform\.ao_probe/,
    );

    // TRUNCATE is blocked by the statement-level trigger even though the dev
    // role is a superuser that bypasses REVOKE.
    await expect(sql`truncate table ${sql.table(T)}`.execute(db)).rejects.toThrow(
      /append-only violation: TRUNCATE on platform\.ao_probe/,
    );
  });

  it('erasure exception is inert until plan 16 creates the cdf_erasure role', async () => {
    const present = (
      await sql<{
        present: boolean;
      }>`select to_regrole('cdf_erasure') is not null as present`.execute(db)
    ).rows[0].present;
    expect(present).toBe(false);

    // With no erasure role, no session bypasses the guard.
    await expect(
      sql`update ${sql.table(T)} set created_at = now() where id = ${seed}`.execute(db),
    ).rejects.toThrow(/append-only violation/);
  });

  it('dropAppendOnly restores mutability (for down migrations)', async () => {
    await dropAppendOnly(db, T);
    await expect(
      sql`update ${sql.table(T)} set created_at = now() where id = ${seed}`.execute(db),
    ).resolves.toBeDefined();
    await expect(sql`truncate table ${sql.table(T)}`.execute(db)).resolves.toBeDefined();
  });
});
