import { Kysely, sql } from 'kysely';

/**
 * Core plan 03 (ADR-0011/0014): `platform.person_merge` (reversible supersede
 * links, PL-038/039) and `platform.person_flag` (safeguarding flags with
 * never-lose semantics, PL-040).
 *
 * Both are append-only with exactly ONE permitted lifecycle UPDATE — the
 * generic `append_only_guard` forbids all mutation, so like `domain_event` each
 * gets a specialised guard:
 *
 *  - `person_merge`: a one-time reversal stamp (reversed_by/reversed_at/
 *    reversal_reason), NULL -> value, nothing else changes.
 *  - `person_flag`:  a one-time close-out stamp (ended_by/ended_at/end_reason),
 *    NULL -> value, nothing else changes. Never deleted (no soft delete either).
 *
 * `updated_at` is trigger-maintained and permitted to change on the stamp. The
 * erasure role (plan 16, ADR-0019) bypasses, consistent with the generic guard.
 * TRUNCATE is blocked statement-level via the generic guard.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- platform.person_merge ---------------------------------------------
  await db.schema
    .createTable('platform.person_merge')
    .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7
    .addColumn('superseded_person_id', 'uuid', (c) => c.notNull().references('platform.person.id'))
    .addColumn('surviving_person_id', 'uuid', (c) => c.notNull().references('platform.person.id'))
    .addColumn('reason', 'text', (c) => c.notNull())
    // text[] of "user".id repointed by the merge — the exact reversal set.
    .addColumn('moved_user_ids', 'jsonb', (c) => c.notNull())
    .addColumn('merged_by', 'uuid', (c) => c.notNull().references('platform.person.id'))
    .addColumn('merged_at', 'timestamptz', (c) => c.notNull())
    .addColumn('reversed_by', 'uuid', (c) => c.references('platform.person.id'))
    .addColumn('reversed_at', 'timestamptz')
    .addColumn('reversal_reason', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('person_merge_distinct', sql`superseded_person_id <> surviving_person_id`)
    .execute();

  // One live supersede per person; chains only through the surviving side.
  await sql`
    CREATE UNIQUE INDEX person_merge_active_uq
      ON platform.person_merge (superseded_person_id) WHERE reversed_at IS NULL
  `.execute(db);
  await db.schema
    .createIndex('person_merge_surviving_idx')
    .on('platform.person_merge')
    .column('surviving_person_id')
    .execute();

  await sql`
    CREATE FUNCTION platform.person_merge_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- Erasure-role bypass (ADR-0019, plan 16). Defensive: no-op until the role
      -- exists (current_user membership, never a session GUC).
      IF to_regrole('cdf_erasure') IS NOT NULL
         AND pg_has_role(current_user, 'cdf_erasure', 'MEMBER') THEN
        RETURN COALESCE(NEW, OLD);
      END IF;

      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'platform.person_merge is append-only (ADR-0011): DELETE blocked';
      END IF;

      -- The single permitted UPDATE: the one-time reversal stamp. reversed_at
      -- goes NULL -> value; only the reversal columns (+ updated_at) may change.
      IF OLD.reversed_at IS NULL
         AND NEW.reversed_at IS NOT NULL
         AND (to_jsonb(OLD) - 'reversed_by' - 'reversed_at' - 'reversal_reason' - 'updated_at')
           = (to_jsonb(NEW) - 'reversed_by' - 'reversed_at' - 'reversal_reason' - 'updated_at') THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'platform.person_merge is append-only (ADR-0011): only the one-time reversal stamp is permitted';
    END;
    $$;
  `.execute(db);

  await sql`REVOKE UPDATE, DELETE, TRUNCATE ON platform.person_merge FROM PUBLIC`.execute(db);
  await sql`
    CREATE TRIGGER person_merge_guard BEFORE UPDATE OR DELETE
      ON platform.person_merge FOR EACH ROW
      EXECUTE FUNCTION platform.person_merge_guard()
  `.execute(db);
  await sql`
    CREATE TRIGGER person_merge_guard_truncate BEFORE TRUNCATE
      ON platform.person_merge FOR EACH STATEMENT
      EXECUTE FUNCTION platform.append_only_guard()
  `.execute(db);
  // updated_at maintained by trigger; the guard permits it on the reversal stamp.
  await sql`
    CREATE TRIGGER person_merge_set_updated_at BEFORE UPDATE
      ON platform.person_merge FOR EACH ROW
      EXECUTE FUNCTION platform.set_updated_at()
  `.execute(db);

  // --- platform.person_flag ----------------------------------------------
  await db.schema
    .createTable('platform.person_flag')
    .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7
    .addColumn('person_id', 'uuid', (c) => c.notNull().references('platform.person.id'))
    .addColumn('flag_type', 'text', (c) =>
      c.notNull().check(sql`flag_type IN ('do_not_rehire', 'safeguarding', 'safety', 'other')`),
    )
    .addColumn('reason', 'text', (c) => c.notNull())
    // Set when this row was copied onto a survivor by a merge union (PL-040).
    .addColumn('source_merge_id', 'uuid', (c) => c.references('platform.person_merge.id'))
    .addColumn('source_flag_id', 'uuid', (c) => c.references('platform.person_flag.id'))
    .addColumn('raised_by', 'uuid', (c) => c.notNull().references('platform.person.id'))
    .addColumn('raised_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ended_by', 'uuid', (c) => c.references('platform.person.id'))
    // Explicit admin close-out only; never deleted (never-lose, PL-040).
    .addColumn('ended_at', 'timestamptz')
    .addColumn('end_reason', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    CREATE INDEX person_flag_active_idx
      ON platform.person_flag (person_id) WHERE ended_at IS NULL
  `.execute(db);

  await sql`
    CREATE FUNCTION platform.person_flag_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF to_regrole('cdf_erasure') IS NOT NULL
         AND pg_has_role(current_user, 'cdf_erasure', 'MEMBER') THEN
        RETURN COALESCE(NEW, OLD);
      END IF;

      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'platform.person_flag is never deleted (PL-040): DELETE blocked';
      END IF;

      -- The single permitted UPDATE: the one-time close-out stamp. ended_at goes
      -- NULL -> value; only the close-out columns (+ updated_at) may change.
      IF OLD.ended_at IS NULL
         AND NEW.ended_at IS NOT NULL
         AND (to_jsonb(OLD) - 'ended_by' - 'ended_at' - 'end_reason' - 'updated_at')
           = (to_jsonb(NEW) - 'ended_by' - 'ended_at' - 'end_reason' - 'updated_at') THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'platform.person_flag is append-only (PL-040): only the one-time close-out stamp is permitted';
    END;
    $$;
  `.execute(db);

  await sql`REVOKE UPDATE, DELETE, TRUNCATE ON platform.person_flag FROM PUBLIC`.execute(db);
  await sql`
    CREATE TRIGGER person_flag_guard BEFORE UPDATE OR DELETE
      ON platform.person_flag FOR EACH ROW
      EXECUTE FUNCTION platform.person_flag_guard()
  `.execute(db);
  await sql`
    CREATE TRIGGER person_flag_guard_truncate BEFORE TRUNCATE
      ON platform.person_flag FOR EACH STATEMENT
      EXECUTE FUNCTION platform.append_only_guard()
  `.execute(db);
  await sql`
    CREATE TRIGGER person_flag_set_updated_at BEFORE UPDATE
      ON platform.person_flag FOR EACH ROW
      EXECUTE FUNCTION platform.set_updated_at()
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.person_flag').ifExists().execute();
  await db.schema.dropTable('platform.person_merge').ifExists().execute();
  await sql`DROP FUNCTION IF EXISTS platform.person_flag_guard()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS platform.person_merge_guard()`.execute(db);
}
