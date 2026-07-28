import { Kysely, sql } from 'kysely';
import { attachUpdatedAtTrigger, withStandardColumns } from '../migration-helpers.js';

/**
 * Core plan 04 (ADR-0015, PL-002/004/043, CORE-05): the authorisation
 * substrate — roles as data, per-module time-boxable grants, and the restricted
 * external-administrator's allocated-people table.
 *
 * History class (ADR-0012) for all three: "everything else" — mutable state +
 * journal events for meaningful changes. So standard columns + the
 * `set_updated_at` trigger, NOT append-only. What makes the history survive is
 * the *shape*, not a guard: a grant is **revoked** (a new timestamp), never
 * re-pointed to a different role/module and never hard-deleted, and an
 * allocation is **ended**, never deleted. Re-engagement inserts a new row.
 *
 * `created_by`/`updated_by` carry real FKs to `platform.person` here (unlike the
 * helper default) because an authorisation change with an unresolvable actor is
 * not auditable. The eleven seeded roles predate any person, so `role`'s stamps
 * stay nullable — NULL means "seeded by migration".
 */

/**
 * The SoW §10 standard role set + `external_administrator` (CORE-05), with
 * FIXED UUIDv7 ids so every environment agrees and a grant row means the same
 * thing in dev, test and production. Ids are ordered, so seed order is id order.
 *
 * `role.key` is deliberately NOT CHECK-constrained: roles are data (PL-002), so
 * a Phase 2 role addition must not need a migration. The keys are mirrored as a
 * constant tuple in `@repo/trpc` (`ROLE_KEYS`) for type-safe builder arguments.
 */
const SEED_ROLES: ReadonlyArray<{ id: string; key: string; name: string; description: string }> = [
  {
    id: '019f509e-9d00-7000-8000-000000000000',
    key: 'administrator',
    name: 'Administrator',
    description: 'Platform administration: roles, grants, configuration and audit.',
  },
  {
    id: '019f509e-9d01-7000-8000-000000000001',
    key: 'hr_user',
    name: 'HR User',
    description: 'HR operations across the person record, evidence, documents and HR modules.',
  },
  {
    id: '019f509e-9d02-7000-8000-000000000002',
    key: 'line_manager',
    name: 'Line Manager',
    description: 'Team-scoped visibility and approvals for their own team (PL-004).',
  },
  {
    id: '019f509e-9d03-7000-8000-000000000003',
    key: 'finance',
    name: 'Finance',
    description: 'Finance-facing tasks and provisioning steps.',
  },
  {
    id: '019f509e-9d04-7000-8000-000000000004',
    key: 'it',
    name: 'IT',
    description: 'IT provisioning and equipment tasks.',
  },
  {
    id: '019f509e-9d05-7000-8000-000000000005',
    key: 'transport',
    name: 'Transport',
    description: 'Transport provisioning tasks (licences, vehicles).',
  },
  {
    id: '019f509e-9d06-7000-8000-000000000006',
    key: 'office_admin',
    name: 'Admin (operational)',
    description:
      'Operational administration tasks. Keyed office_admin to avoid collision with Administrator and Better Auth’s framework admin role.',
  },
  {
    id: '019f509e-9d07-7000-8000-000000000007',
    key: 'director',
    name: 'Director',
    description: 'Organisation-wide visibility, largely aggregate (SoW §10).',
  },
  {
    id: '019f509e-9d08-7000-8000-000000000008',
    key: 'employee',
    name: 'Employee / Candidate',
    description: 'Self-service over their own records.',
  },
  {
    id: '019f509e-9d09-7000-8000-000000000009',
    key: 'external',
    name: 'External / Agency',
    description: 'External or agency worker; own records only, no sensitive data (PL-043).',
  },
  {
    id: '019f509e-9d0a-7000-8000-00000000000a',
    key: 'external_administrator',
    name: 'External Administrator',
    description:
      'Restricted non-employed-worker intake (CORE-05): allocated people only; structurally excluded from approval, readiness and confidential surfaces.',
  },
];

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- platform.role ------------------------------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.role')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('key', 'text', (c) => c.notNull().unique())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('description', 'text')
      // Seeded rows are the SoW §10 set; is_system rows are not deletable.
      .addColumn('is_system', 'boolean', (c) => c.notNull().defaultTo(true)),
    { actorStamps: false },
  )
    .addColumn('created_by', 'uuid')
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint('role_created_by_fkey', ['created_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('role_updated_by_fkey', ['updated_by'], 'platform.person', ['id'])
    .execute();

  await sql`
    COMMENT ON TABLE platform.role IS
      'The role set as data (PL-002, SoW §10). key is intentionally not CHECK-constrained so a Phase 2 role needs no migration; is_system rows are not deletable.'
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.role');

  // --- platform.role_grant ------------------------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.role_grant')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('person_id', 'uuid', (c) => c.notNull().references('platform.person.id'))
      .addColumn('role_id', 'uuid', (c) => c.notNull().references('platform.role.id'))
      // The grant's scope: which functional area this role applies in. A grant
      // satisfies a procedure only on an EXACT match — there is no wildcard
      // module (core plan 04 Q5, resolved 2026-07-28).
      .addColumn('module', 'text', (c) =>
        c.notNull().check(sql`module IN ('platform', 'hr.core', 'hr.onboarding', 'hr.holiday_leave',
                              'hr.sickness_absence', 'hr.er', 'hr.ld', 'hr.offboarding',
                              'hr.wellbeing', 'hr.reporting')`),
      )
      .addColumn('valid_from', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      // NULL = open-ended; set for externals (PL-042 substrate).
      .addColumn('valid_until', 'timestamptz')
      .addColumn('revoked_at', 'timestamptz')
      .addColumn('revoked_by', 'uuid')
      .addColumn('revoke_reason', 'text'),
    { actorStamps: false },
  )
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint('role_grant_created_by_fkey', ['created_by'], 'platform.person', [
      'id',
    ])
    .addForeignKeyConstraint('role_grant_updated_by_fkey', ['updated_by'], 'platform.person', [
      'id',
    ])
    .addForeignKeyConstraint('role_grant_revoked_by_fkey', ['revoked_by'], 'platform.person', [
      'id',
    ])
    .addCheckConstraint(
      'role_grant_window_ordered',
      sql`valid_until IS NULL OR valid_until > valid_from`,
    )
    // An actor may only be recorded on an actual revocation. The converse is NOT
    // required: `revoked_by IS NULL` on a revoked grant means the *system* did
    // it (the plan-03 expiry sweep), matching the repo-wide NULL-actor
    // convention for `created_by`/`updated_by` and `appendEvent`.
    .addCheckConstraint(
      'role_grant_revoker_needs_revocation',
      sql`revoked_by IS NULL OR revoked_at IS NOT NULL`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.role_grant IS
      'A role granted to a person, scoped to one module, optionally time-boxed (PL-002; PL-042 substrate). Grants are revoked, never re-pointed or hard-deleted — history survives as rows + journal events (ADR-0012). Activity is derived from the timestamps; there is no mutable active flag.'
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.role_grant');

  // One live grant per (person, role, module) — re-granting an already-live
  // combination is a no-op the API should reject, not a duplicate row.
  await sql`
    CREATE UNIQUE INDEX role_grant_live_uq
      ON platform.role_grant (person_id, role_id, module)
      WHERE revoked_at IS NULL AND deleted_at IS NULL
  `.execute(db);
  // Hot path: resolve a person's live grants on every authenticated request.
  await sql`
    CREATE INDEX role_grant_person_active_ix
      ON platform.role_grant (person_id)
      WHERE revoked_at IS NULL AND deleted_at IS NULL
  `.execute(db);
  // Expiry sweep (plan 03's access-expiry job): grants past their valid_until.
  await sql`
    CREATE INDEX role_grant_expiry_ix
      ON platform.role_grant (valid_until)
      WHERE valid_until IS NOT NULL AND revoked_at IS NULL AND deleted_at IS NULL
  `.execute(db);

  // --- platform.person_allocation (CORE-05) -------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.person_allocation')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      // The restricted external administrator.
      .addColumn('admin_person_id', 'uuid', (c) => c.notNull().references('platform.person.id'))
      // The person they may reach.
      .addColumn('person_id', 'uuid', (c) => c.notNull().references('platform.person.id'))
      .addColumn('valid_from', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      // Time-box, aligned with the administrator's own access window.
      .addColumn('valid_until', 'timestamptz')
      .addColumn('ended_at', 'timestamptz')
      .addColumn('ended_by', 'uuid')
      .addColumn('end_reason', 'text'),
    { actorStamps: false },
  )
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint(
      'person_allocation_created_by_fkey',
      ['created_by'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'person_allocation_updated_by_fkey',
      ['updated_by'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint('person_allocation_ended_by_fkey', ['ended_by'], 'platform.person', [
      'id',
    ])
    .addCheckConstraint('person_allocation_not_self', sql`admin_person_id <> person_id`)
    .addCheckConstraint(
      'person_allocation_window_ordered',
      sql`valid_until IS NULL OR valid_until > valid_from`,
    )
    .addCheckConstraint(
      'person_allocation_ender_needs_ending',
      sql`ended_by IS NULL OR ended_at IS NOT NULL`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.person_allocation IS
      'Which people a restricted external administrator may access (CORE-05). The allocated record scope resolves through live rows here; ending an allocation (never deleting it) closes the window while the history survives.'
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.person_allocation');

  await sql`
    CREATE UNIQUE INDEX person_allocation_live_uq
      ON platform.person_allocation (admin_person_id, person_id)
      WHERE ended_at IS NULL AND deleted_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX person_allocation_admin_ix
      ON platform.person_allocation (admin_person_id)
      WHERE ended_at IS NULL AND deleted_at IS NULL
  `.execute(db);

  // --- Seed the standard role set (PL-002) --------------------------------
  await db.insertInto('platform.role').values(SEED_ROLES).execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.person_allocation').ifExists().execute();
  await db.schema.dropTable('platform.role_grant').ifExists().execute();
  await db.schema.dropTable('platform.role').ifExists().execute();
}
