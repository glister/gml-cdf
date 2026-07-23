import { Kysely, sql } from 'kysely';
import { attachUpdatedAtTrigger, withStandardColumns } from '../migration-helpers.js';

/**
 * Core plan 03 (ADR-0014, CORE-01): `platform.person` — the permanent identity
 * anchor every module hangs its data off. One durable UUIDv7 surrogate id per
 * human being (never a login credential — PL-034), carrying the person's
 * lifecycle on three *separate* CHECK-constrained dimensions (CORE-01):
 *
 *  - `relationship_type` — who they are to CDF (employee / agency / …). RBAC
 *    external scoping keys on `<> 'employee'` (PL-043, plan 04).
 *  - `profile_status`    — the business lifecycle (draft_shell → … → reactivated);
 *    every change is journalled as history, never overwritten.
 *  - `status`            — identity/access state (active/inactive/superseded)
 *    governing sign-in and merge bookkeeping.
 *
 * The fourth concern — work-readiness — is DERIVED (plan 17, ADR-0020) and is
 * deliberately NOT a column here.
 *
 * History class (ADR-0012): "everything else" — mutable state + journal events
 * for meaningful changes. So standard columns + `set_updated_at` trigger, NOT
 * append-only. `created_by`/`updated_by` self-reference `platform.person` (the
 * inviter for externals; NULL = system, e.g. first Entra SSO).
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await withStandardColumns(
    db.schema
      .createTable('platform.person')
      // UUIDv7, app-generated; NEVER a credential (PL-034).
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('relationship_type', 'text', (c) =>
        c.notNull().check(sql`relationship_type IN ('employee', 'agency', 'subcontractor',
                                 'self_employed', 'external_org_employee', 'candidate')`),
      )
      .addColumn('profile_status', 'text', (c) =>
        c.notNull().defaultTo('draft_shell')
          .check(sql`profile_status IN ('draft_shell', 'information_requested', 'information_submitted',
                              'pending_review', 'incomplete_rejected', 'approved_not_active',
                              'active', 'active_with_restrictions', 'inactive',
                              'leaver', 'reactivated')`),
      )
      .addColumn('status', 'text', (c) =>
        c
          .notNull()
          .defaultTo('active')
          .check(sql`status IN ('active', 'inactive', 'superseded')`),
      )
      .addColumn('display_name', 'text', (c) => c.notNull())
      .addColumn('given_name', 'text')
      .addColumn('family_name', 'text')
      // Contact detail only; the authn email lives on Better Auth "user".
      .addColumn('contact_email', 'text')
      // Natural-identity attributes — decision aids for duplicate detection only,
      // never an authentication factor or claim mechanism (PL-037, PL-041).
      .addColumn('date_of_birth', 'date')
      .addColumn('agency_worker_reference', 'text')
      // End/review date for non-employees (PL-042, PL-046); cleared on conversion.
      .addColumn('access_valid_until', 'timestamptz'),
    // Standard columns minus actor stamps — we add those with self-FKs below.
    { actorStamps: false },
  )
    .addColumn('created_by', 'uuid')
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint('person_created_by_fkey', ['created_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('person_updated_by_fkey', ['updated_by'], 'platform.person', ['id'])
    // Access expiry is a non-employee concept only (ADR-0014).
    .addCheckConstraint(
      'person_access_expiry_not_for_employees',
      sql`access_valid_until IS NULL OR relationship_type <> 'employee'`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.person IS
      'Permanent identity anchor (ADR-0014, CORE-01). id is a surrogate, never a credential (PL-034). relationship_type / profile_status / status are three separate lifecycle dimensions; work-readiness is derived (plan 17), never stored.'
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.person');

  // Duplicate detection (PL-037): name+DoB and agency-ref lookups, live rows only.
  await sql`
    CREATE INDEX person_name_dob_idx
      ON platform.person (lower(family_name), lower(given_name), date_of_birth)
      WHERE deleted_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX person_agency_ref_idx
      ON platform.person (lower(agency_worker_reference))
      WHERE agency_worker_reference IS NOT NULL AND deleted_at IS NULL
  `.execute(db);
  // Access-expiry sweep (PL-042): the worker selects active, expiring rows.
  await sql`
    CREATE INDEX person_access_expiry_idx
      ON platform.person (access_valid_until)
      WHERE access_valid_until IS NOT NULL AND status = 'active'
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.person').ifExists().execute();
}
