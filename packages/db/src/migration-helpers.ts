import { type CreateTableBuilder, type Kysely, sql } from 'kysely';

/**
 * Reusable migration utilities implementing the ADR-0011 table conventions
 * (core plan 01 §4.2/§4.4). Imported by later migrations as
 * `../migration-helpers.js` (relative, same package). This file is a package
 * subpath export (`@repo/db/migration-helpers`) and is deliberately **not**
 * re-exported from the package root — it is migration-only code and runtime
 * consumers should never reach it.
 *
 * It must live outside `src/migrations/` because `FileMigrationProvider` treats
 * every file in that folder as a migration.
 */

/**
 * Split a schema-qualified table name (`platform.domain_event`) into its parts.
 * Every module table is schema-qualified (ADR-0008), so a bare name is a bug.
 */
function splitQualified(qualified: string): { schema: string; table: string } {
  const dot = qualified.indexOf('.');
  if (dot === -1) {
    throw new Error(
      `migration helper requires a schema-qualified table name (e.g. 'platform.domain_event'), got: '${qualified}'`,
    );
  }
  return { schema: qualified.slice(0, dot), table: qualified.slice(dot + 1) };
}

export interface StandardColumnOptions {
  /** Add `deleted_at timestamptz` (soft delete). Default true. */
  softDelete?: boolean;
  /** Add `created_by`/`updated_by uuid` actor stamps. Default true. */
  actorStamps?: boolean;
  /**
   * Add `updated_at timestamptz`. Default true. Append-only tables
   * (ADR-0011 §4.2) set this false — they are never updated, so they carry no
   * `updated_at` and get no `set_updated_at` trigger.
   */
  updatedAt?: boolean;
}

/**
 * Add the ADR-0011 standard columns to a `createTable` builder:
 *
 *   created_at  timestamptz NOT NULL DEFAULT now()
 *   updated_at  timestamptz NOT NULL DEFAULT now()   -- maintained by set_updated_at trigger
 *   deleted_at  timestamptz                          -- soft delete only
 *   created_by  uuid                                 -- person id; NULL = system actor
 *   updated_by  uuid                                 -- person id; NULL = system actor
 *
 * `created_by`/`updated_by` carry no FK by default (the authoritative actor is
 * the journal's `actor_person_id`, and `platform.person` lands later); NULL
 * means a system actor (scheduler, relay, migration import). Individual tables
 * may add an FK where referential enforcement is worth it.
 *
 * Pair with `attachUpdatedAtTrigger` in the same migration so `updated_at` is
 * trigger-maintained rather than set per-procedure.
 */
export function withStandardColumns<TB extends CreateTableBuilder<never, never>>(
  builder: TB,
  opts: StandardColumnOptions = {},
): TB {
  const { softDelete = true, actorStamps = true, updatedAt = true } = opts;

  let b = builder.addColumn('created_at', 'timestamptz', (c) =>
    c.notNull().defaultTo(sql`now()`),
  ) as TB;

  if (updatedAt) {
    b = b.addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`)) as TB;
  }
  if (softDelete) {
    b = b.addColumn('deleted_at', 'timestamptz') as TB;
  }
  if (actorStamps) {
    b = b.addColumn('created_by', 'uuid').addColumn('updated_by', 'uuid') as TB;
  }
  return b;
}

/**
 * Make a table append-only (ADR-0011 §4.2): revoke UPDATE/DELETE/TRUNCATE from
 * PUBLIC and attach the `append_only_guard` trigger, which blocks mutation for
 * every caller (owner included) except the future erasure role. Apply to
 * journal, ledger, transition-log and signature-evidence tables.
 *
 * Two triggers are attached, because the Phase 1 dev role is a Postgres
 * superuser (assumption A3) and superusers bypass `REVOKE`:
 *  - a row-level `BEFORE UPDATE OR DELETE` trigger (blocks row mutation), and
 *  - a statement-level `BEFORE TRUNCATE` trigger (blocks TRUNCATE, which row
 *    triggers do not see).
 * Triggers fire regardless of role, so immutability holds even for the
 * superuser owner; the REVOKE is belt-and-braces for future least-privileged
 * roles. The same guard function serves both trigger levels.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function makeAppendOnly(db: Kysely<any>, qualified: string): Promise<void> {
  const { table } = splitQualified(qualified);
  await sql`REVOKE UPDATE, DELETE, TRUNCATE ON ${sql.table(qualified)} FROM PUBLIC`.execute(db);
  await sql`
    CREATE TRIGGER ${sql.id(`${table}_append_only`)}
      BEFORE UPDATE OR DELETE ON ${sql.table(qualified)}
      FOR EACH ROW EXECUTE FUNCTION platform.append_only_guard()
  `.execute(db);
  await sql`
    CREATE TRIGGER ${sql.id(`${table}_append_only_truncate`)}
      BEFORE TRUNCATE ON ${sql.table(qualified)}
      FOR EACH STATEMENT EXECUTE FUNCTION platform.append_only_guard()
  `.execute(db);
}

/** Reverse `makeAppendOnly` (for `down` migrations and test teardown). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dropAppendOnly(db: Kysely<any>, qualified: string): Promise<void> {
  const { table } = splitQualified(qualified);
  await sql`DROP TRIGGER IF EXISTS ${sql.id(`${table}_append_only_truncate`)} ON ${sql.table(qualified)}`.execute(
    db,
  );
  await sql`DROP TRIGGER IF EXISTS ${sql.id(`${table}_append_only`)} ON ${sql.table(qualified)}`.execute(
    db,
  );
  await sql`GRANT UPDATE, DELETE, TRUNCATE ON ${sql.table(qualified)} TO PUBLIC`.execute(db);
}

/**
 * Attach the `set_updated_at` trigger so `updated_at` is stamped on every
 * UPDATE without the application setting it. Apply to every table that carries
 * `updated_at` (i.e. every non-append-only table).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function attachUpdatedAtTrigger(db: Kysely<any>, qualified: string): Promise<void> {
  const { table } = splitQualified(qualified);
  await sql`
    CREATE TRIGGER ${sql.id(`${table}_set_updated_at`)}
      BEFORE UPDATE ON ${sql.table(qualified)}
      FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at()
  `.execute(db);
}

/** Reverse `attachUpdatedAtTrigger` (for `down` migrations). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dropUpdatedAtTrigger(db: Kysely<any>, qualified: string): Promise<void> {
  const { table } = splitQualified(qualified);
  await sql`DROP TRIGGER IF EXISTS ${sql.id(`${table}_set_updated_at`)} ON ${sql.table(qualified)}`.execute(
    db,
  );
}
