import { Kysely, sql } from 'kysely';
import { attachUpdatedAtTrigger, withStandardColumns } from '../migration-helpers.js';

/**
 * Core plan 05 §4.1.2 (ADR-0016/0012, PL-005d/005e, PL-007a): teams — the one
 * Tier 3 configuration entity the core platform owns, and the exemplar every
 * later Tier 3 entity (plan 14's `hr.role_type`, the HR set's registers,
 * calendars and pattern templates) is built against.
 *
 * A team is not a list. It carries relationships (manager, deputy, members),
 * an attribute the domain engines read (capacity), its own admin screens and
 * effective-dated membership. Treating entities like this as "lists" is the
 * single most likely cause of under-scoping the reference-data service
 * (SoW §5.3.1) — §4.6's conformance checklist exists to stop that.
 *
 * **Teams point at `platform.person`, not `hr.employee`.** Person is the
 * permanent surrogate identity every module keys on (ADR-0014), the employee
 * record will itself carry a 1:1 `person_id`, and a `platform` table FK-ing
 * into `hr` would invert the module dependency direction (ADR-0008). An
 * employees-only rule, if HR ever wants one, is an application guard in the HR
 * module — not a schema change here.
 *
 * History classes (ADR-0012) differ between the two tables, deliberately:
 *
 *  - `platform.team` is "everything else" — mutable state + journal events.
 *    Manager and deputy are current-state columns, NOT membership rows: the
 *    temporal question ("who approved, and why were they allowed to?") is
 *    answered by the journal and the approval record at decision time, so
 *    effective-dating managership would be paid for nothing.
 *  - `platform.team_membership` is **effective-dated** — entitlement and
 *    calendar queries genuinely ask "who was in this team on date D?".
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // Needed by the membership overlap EXCLUDE constraint below. On Azure
  // Database for PostgreSQL Flexible Server this extension must be allow-listed
  // via the `azure.extensions` server parameter before the migration runs
  // (§12.1, §12.3).
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db);

  // --- platform.team ------------------------------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.team')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('description', 'text')
      .addColumn('manager_person_id', 'uuid', (c) => c.notNull().references('platform.person.id'))
      .addColumn('deputy_person_id', 'uuid', (c) => c.references('platform.person.id'))
      // Capacity: how many members may be off at once. A property of the team
      // (SoW §5.3 names capacity as part of a team), read by Holiday & Leave
      // for the max-off-at-once SOFT warning (HL AC-4). Global leave-policy
      // thresholds are decision points and stay in the config store (plan 06).
      .addColumn('max_concurrent_leave', 'integer')
      // Plan 05 §12.2 Q7, resolved 2026-08-03: added here rather than left for
      // plan 12 to ALTER. Plan 12 colours calendar items by team and falls back
      // to per-kind colours when this is NULL.
      .addColumn('colour', 'text'),
    { actorStamps: false },
  )
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid', (c) => c.notNull())
    .addForeignKeyConstraint('team_created_by_fkey', ['created_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('team_updated_by_fkey', ['updated_by'], 'platform.person', ['id'])
    .addCheckConstraint(
      'team_capacity_check',
      sql`max_concurrent_leave IS NULL OR max_concurrent_leave >= 1`,
    )
    // A deputy exists to cover for the manager; naming the same person is a
    // data-entry slip, not a configuration.
    .addCheckConstraint(
      'team_deputy_not_manager_check',
      sql`deputy_person_id IS NULL OR deputy_person_id <> manager_person_id`,
    )
    .addCheckConstraint(
      'team_colour_format_check',
      sql`colour IS NULL OR colour ~ '^#[0-9a-f]{6}$'`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.team IS
      'Tier 3 configuration entity (PL-005d/e): manager, deputy, members and capacity. Teams FK platform.person, never hr.employee (ADR-0008/0014). Archived by soft delete, which end-dates its open memberships in the same transaction.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.team.colour IS
      'Optional hex colour for calendar rendering (plan 12 colour-by-team; core plan 05 §12.2 Q7). NULL means the consumer falls back to its own per-kind colours.'
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.team');

  // One live team per name; archiving frees the name for reuse.
  await sql`
    CREATE UNIQUE INDEX team_name_live_unique
      ON platform.team (lower(name)) WHERE deleted_at IS NULL
  `.execute(db);

  // --- platform.team_membership -------------------------------------------
  //
  // Documented ADR-0011 deviation: NO `deleted_at`. Membership lifecycle is
  // effective dating (ADR-0012) — a membership is ended or corrected, never
  // soft-deleted. Plan 04's scoping helpers rely on exactly this shape ("not a
  // soft-deleted membership flag"), so adding the column would create a second,
  // contradictory way to express "no longer a member".
  await withStandardColumns(
    db.schema
      .createTable('platform.team_membership')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('team_id', 'uuid', (c) => c.notNull().references('platform.team.id'))
      .addColumn('person_id', 'uuid', (c) => c.notNull().references('platform.person.id'))
      // Business-day granularity, half-open [valid_from, valid_to): leave and
      // absence consumers reason in days, not instants.
      .addColumn('valid_from', 'date', (c) => c.notNull())
      .addColumn('valid_to', 'date'), // NULL = current
    { actorStamps: false, softDelete: false },
  )
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid', (c) => c.notNull())
    .addForeignKeyConstraint('team_membership_created_by_fkey', ['created_by'], 'platform.person', [
      'id',
    ])
    .addForeignKeyConstraint('team_membership_updated_by_fkey', ['updated_by'], 'platform.person', [
      'id',
    ])
    .addCheckConstraint(
      'team_membership_dates_check',
      sql`valid_to IS NULL OR valid_to > valid_from`,
    )
    .execute();

  // The temporal invariant as a DATABASE property, in the spirit of ADR-0011's
  // "immutability is a database property, not an application promise": a person
  // cannot hold two overlapping membership rows in the same team. Adjacent
  // ranges ([a,b) then [b,c)) are fine — that is what half-open buys.
  await sql`
    ALTER TABLE platform.team_membership
      ADD CONSTRAINT team_membership_no_overlap EXCLUDE USING gist (
        team_id WITH =,
        person_id WITH =,
        daterange(valid_from, valid_to, '[)') WITH &&
      )
  `.execute(db);

  await sql`
    COMMENT ON TABLE platform.team_membership IS
      'Effective-dated team membership (ADR-0012, PL-007a): half-open [valid_from, valid_to), valid_to NULL = current. No deleted_at by design — memberships are ended or corrected, never soft-deleted; plan 04 record scoping resolves through this shape.'
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.team_membership');

  await sql`
    CREATE INDEX team_membership_team_idx ON platform.team_membership (team_id, valid_from)
  `.execute(db);
  // The hot path for plan 04's `managedPersonIds` record scoping.
  await sql`
    CREATE INDEX team_membership_person_idx ON platform.team_membership (person_id, valid_from)
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.team_membership').ifExists().execute();
  await db.schema.dropTable('platform.team').ifExists().execute();
  // `btree_gist` is deliberately NOT dropped: it is a database-level facility
  // other tables may already depend on, and CREATE EXTENSION IF NOT EXISTS makes
  // re-running `up` idempotent either way.
}
