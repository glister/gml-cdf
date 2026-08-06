import { Kysely, sql } from 'kysely';
import { attachUpdatedAtTrigger, withStandardColumns } from '../migration-helpers.js';

/**
 * Core plan 06 §4.1 (ADR-0016/0012/0011, PL-029/030): `platform.config_entry` —
 * the effective-dated, schema-validated, audited store every decision-point
 * value lives in, so CDF can change behaviour without a release and no change
 * ever rewrites the past.
 *
 * One row per **version** of a key. The row with `valid_to IS NULL` is the value
 * currently in force; windows tile exactly (`valid_to` of the predecessor equals
 * `valid_from` of the successor), so for any instant at most one row satisfies
 * `valid_from <= t AND (valid_to IS NULL OR valid_to > t)`. Boundaries are
 * half-open `[valid_from, valid_to)`, matching every other effective-dated table
 * in the system (`platform.team_membership`, ADR-0012) — the changeover instant
 * reads the NEW value.
 *
 * History class (ADR-0012): "temporally versioned reference/config" →
 * **effective dating**. Two documented ADR-0011 deviations follow from that:
 *
 *  - **No `deleted_at`.** Lifecycle is the validity window. A key is "removed"
 *    by closing its open row with no successor (reset-to-default), whereupon
 *    reads fall back to the registry's frozen code default. A soft-delete flag
 *    would be a second, contradictory way to say "not in force".
 *  - **Close-only, not append-only.** The generic `append_only_guard` forbids
 *    every UPDATE, but supersede *must* stamp `valid_to` on the predecessor.
 *    `config_entry_guard` therefore permits exactly one move — the close — and
 *    rejects everything else, so a closed row can never be reopened or altered
 *    and a value can never be edited in place. History is a database property,
 *    not an application promise (ADR-0011).
 *
 * Unlike `person_merge`/`person_flag`, UPDATE is **not** revoked from PUBLIC:
 * closing a row is a legitimate, trigger-validated part of the write path, so a
 * future least-privileged app role must retain the privilege. DELETE and
 * TRUNCATE are revoked — there is no path that removes a version row.
 *
 * The `value` column is `jsonb` and deliberately untyped in SQL: the code-side
 * schema registry (`@repo/config`) is what makes JSONB safe
 * here, validating on write **and** on read (ADR-0016). No `CHECK` constraint
 * could express a per-key Zod schema, so none pretends to.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await withStandardColumns(
    db.schema
      .createTable('platform.config_entry')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      // Qualified name = `<namespace>.<key>`; namespace is every segment but the
      // last (e.g. 'platform.identity'), key is the last ('external_access_default_days').
      .addColumn('namespace', 'text', (c) => c.notNull())
      .addColumn('key', 'text', (c) => c.notNull())
      // Validated by the code registry on write and on read — never trusted raw.
      .addColumn('value', 'jsonb', (c) => c.notNull())
      .addColumn('valid_from', 'timestamptz', (c) => c.notNull()) // inclusive
      .addColumn('valid_to', 'timestamptz') // exclusive; NULL = in force
      // 1..n per (namespace, key), gapless — enforced by the unique constraint
      // plus the successor's `version = predecessor.version + 1` write path.
      .addColumn('version', 'integer', (c) => c.notNull()),
    { actorStamps: false, softDelete: false },
  )
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid', (c) => c.notNull())
    .addForeignKeyConstraint('config_entry_created_by_fkey', ['created_by'], 'platform.person', [
      'id',
    ])
    .addForeignKeyConstraint('config_entry_updated_by_fkey', ['updated_by'], 'platform.person', [
      'id',
    ])
    .addCheckConstraint(
      'config_entry_namespace_chk',
      // `\\.` is deliberate: a template literal cooks `\.` down to a bare `.`,
      // which would make the separator match any character.
      sql`namespace ~ '^[a-z][a-z0-9_]+(\\.[a-z][a-z0-9_]+)*$'`,
    )
    .addCheckConstraint('config_entry_key_chk', sql`key ~ '^[a-z][a-z0-9_]+$'`)
    .addCheckConstraint('config_entry_version_chk', sql`version >= 1`)
    .addCheckConstraint('config_entry_window_chk', sql`valid_to IS NULL OR valid_to > valid_from`)
    .addUniqueConstraint('config_entry_version_uq', ['namespace', 'key', 'version'])
    .execute();

  await sql`
    COMMENT ON TABLE platform.config_entry IS
      'Effective-dated decision-point values (PL-029/030, ADR-0016). One row per version; valid_to IS NULL = in force. Half-open [valid_from, valid_to). Close-only: config_entry_guard permits nothing but the supersede stamp. No deleted_at by design — reset closes the open row and reads fall back to the registered code default.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.config_entry.value IS
      'Validated against the key''s registered Zod schema on write AND on read (@repo/trpc config registry). A value failing its schema on read is registry drift and raises rather than returning a guess.'
  `.execute(db);

  // Exactly one open (in-force) row per key. Also the arbiter of the
  // first-ever-write race, where there is no predecessor row to lock (§4.1 step 7).
  await sql`
    CREATE UNIQUE INDEX config_entry_one_open_uq
      ON platform.config_entry (namespace, key) WHERE valid_to IS NULL
  `.execute(db);

  // The as-at resolution path: equality on (namespace, key), then the window
  // scan newest-first.
  await sql`
    CREATE INDEX config_entry_as_at_ix
      ON platform.config_entry (namespace, key, valid_from DESC)
  `.execute(db);

  await sql`
    CREATE FUNCTION platform.config_entry_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- Erasure-role bypass (ADR-0019, plan 16). Defensive: no-op until the role
      -- exists (current_user membership, never a session GUC). Config values hold
      -- no personal data (§4.5), so erasure should never need this — it is here
      -- for consistency with every other guard, not because a case is foreseen.
      IF to_regrole('cdf_erasure') IS NOT NULL
         AND pg_has_role(current_user, 'cdf_erasure', 'MEMBER') THEN
        RETURN COALESCE(NEW, OLD);
      END IF;

      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'platform.config_entry is never deleted (PL-030): DELETE blocked';
      END IF;

      -- The single permitted UPDATE: the supersede stamp. valid_to goes
      -- NULL -> value; id, namespace, key, value, valid_from, version,
      -- created_at and created_by are all unchanged. updated_at/updated_by may
      -- change, to record who closed the row.
      IF OLD.valid_to IS NULL
         AND NEW.valid_to IS NOT NULL
         AND (to_jsonb(OLD) - 'valid_to' - 'updated_at' - 'updated_by')
           = (to_jsonb(NEW) - 'valid_to' - 'updated_at' - 'updated_by') THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'platform.config_entry is close-only (ADR-0011/0016): a value is superseded, never edited in place, and a closed row is immutable';
    END;
    $$;
  `.execute(db);

  // ADR-0011: immutability enforced by the database, for every role. UPDATE
  // stays granted — the close stamp is a legitimate move and the guard, not the
  // grant, is what constrains it.
  await sql`REVOKE DELETE, TRUNCATE ON platform.config_entry FROM PUBLIC`.execute(db);
  await sql`
    CREATE TRIGGER config_entry_guard BEFORE UPDATE OR DELETE
      ON platform.config_entry FOR EACH ROW
      EXECUTE FUNCTION platform.config_entry_guard()
  `.execute(db);
  await sql`
    CREATE TRIGGER config_entry_guard_truncate BEFORE TRUNCATE
      ON platform.config_entry FOR EACH STATEMENT
      EXECUTE FUNCTION platform.append_only_guard()
  `.execute(db);

  // `updated_at` is trigger-maintained; the guard permits it on the close stamp.
  await attachUpdatedAtTrigger(db, 'platform.config_entry');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.config_entry').ifExists().execute();
  await sql`DROP FUNCTION IF EXISTS platform.config_entry_guard()`.execute(db);
}
