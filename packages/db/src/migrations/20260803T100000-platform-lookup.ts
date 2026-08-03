import { Kysely, sql } from 'kysely';
import { attachUpdatedAtTrigger, withStandardColumns } from '../migration-helpers.js';

/**
 * Core plan 05 §4.1.1 (ADR-0016, PL-005/005a/005b/006/007): the Tier 1
 * reference-data structure — one shared table for every flat code-and-label
 * enumeration in Phase 1.
 *
 * History class (ADR-0012): "everything else" — mutable state plus journal
 * events. Tier 1 deliberately gets **no** effective dating and **no** version
 * column (SoW §5.3.3); a retired value is deactivated, not deleted, so
 * historical records that FK it still resolve and display (PL-007). Needing
 * versioning machinery on a list here is the signal that the list is really
 * Tier 2 and belongs in a typed table of its own (PL-005c).
 *
 * `created_by`/`updated_by` carry real FKs to `platform.person` (unlike the
 * helper default) and are NOT NULL: reference data is maintained by people
 * without a release, so "who added this value" must always be answerable
 * (PL-005b, AC-D7). The dev seed and the Breathe import (DM-002) each act as a
 * named person.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await withStandardColumns(
    db.schema
      .createTable('platform.lookup')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      // CHECK-constrained on purpose: adding a *value* is data entry (PL-005b),
      // adding a *list type* is a one-line migration, because assigning a list
      // to a tier is a real design decision (ADR-0016). An unconstrained
      // list_type is the first step towards the generic key-value store
      // PL-005c prohibits.
      .addColumn('list_type', 'text', (c) =>
        c.notNull().check(sql`list_type IN ('department', 'job_role', 'document_category',
                              'sickness_type', 'ppe_type', 'leaver_reason', 'equipment_type')`),
      )
      // The stable semantic key: migration mappings (DM-002), seeds and tests
      // reference it, so it is immutable after creation (enforced in the update
      // procedure — a DDL trigger would also block legitimate corrections made
      // through a migration).
      .addColumn('code', 'text', (c) => c.notNull())
      .addColumn('label', 'text', (c) => c.notNull())
      .addColumn('description', 'text')
      .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
      // Retired values stay resolvable (PL-007): hidden from pickers, still
      // joined for display by records that already reference them.
      .addColumn('active', 'boolean', (c) => c.notNull().defaultTo(true)),
    { actorStamps: false },
  )
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid', (c) => c.notNull())
    .addForeignKeyConstraint('lookup_created_by_fkey', ['created_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('lookup_updated_by_fkey', ['updated_by'], 'platform.person', ['id'])
    .addCheckConstraint('lookup_code_format_check', sql`code ~ '^[a-z0-9][a-z0-9_]{0,63}$'`)
    // Includes soft-deleted rows: a deleted code cannot be silently reused with
    // different meaning — reactivate the original instead.
    .addUniqueConstraint('lookup_list_type_code_unique', ['list_type', 'code'])
    // Enables the composite consumer FK pattern (§4.4): a consumer column pair
    // (value_id, 'sickness_type') can only reference a row in that list, so
    // "a sickness record pointing at a PPE type" is a constraint violation
    // rather than a code-review hope.
    .addUniqueConstraint('lookup_id_list_type_unique', ['id', 'list_type'])
    .execute();

  await sql`
    COMMENT ON TABLE platform.lookup IS
      'Tier 1 reference data (PL-005b, ADR-0016): every flat code-and-label enumeration in one shared structure. Values are deactivated, never deleted, so historical references still resolve (PL-007). No versioning by design — a list needing it is Tier 2.'
  `.execute(db);
  await sql`
    COMMENT ON CONSTRAINT lookup_id_list_type_unique ON platform.lookup IS
      'Target of the composite consumer FK pattern (core plan 05 §4.4): consumers reference (id, list_type) so a value can only be used in the list it belongs to.'
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.lookup');

  // The dropdown hot path: active values of one list in display order.
  await sql`
    CREATE INDEX lookup_options_idx
      ON platform.lookup (list_type, active, sort_order, label)
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.lookup').ifExists().execute();
}
