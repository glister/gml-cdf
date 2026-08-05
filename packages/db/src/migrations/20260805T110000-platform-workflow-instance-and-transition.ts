import { Kysely, sql } from 'kysely';
import {
  attachUpdatedAtTrigger,
  makeAppendOnly,
  withStandardColumns,
} from '../migration-helpers.js';

/**
 * Core plan 07 §4.1 (ADR-0013/0011/0012): the workflow runtime's two tables —
 * `platform.workflow_instance` (where a case currently is) and the append-only
 * `platform.workflow_transition` (how it got there).
 *
 * History class (ADR-0012): **process state → transition log.** The instance row
 * holds only the current state; every move between states is an immutable row in
 * the transition log, and the log plus the journal is the complete answer to
 * "how did this case get here?" (PL-026/028). SoW §6 principle 7 made
 * executable: no workflow fact is ever a loose boolean flag.
 *
 * Three column choices are worth their ink:
 *
 *  - **`current_state` / `from_state` / `to_state` / `action` are plain `text`
 *    with no CHECK and no codegen literal union.** The legal value set is
 *    per-definition data, not a schema constant — `platform.demo.request` and
 *    (later) `hr.leave.approval` share this table with disjoint state sets. The
 *    runtime validates each value against the *pinned definition version*, which
 *    a CHECK constraint could not express without a migration per workflow shape
 *    — precisely the "workflow change costs a release" failure ADR-0013 exists
 *    to avoid.
 *  - **`definition_version` pins the instance** (WF-4, mirroring ON-006 snapshot
 *    semantics): registering v2 changes nothing for a case already running on
 *    v1, so a rule change never rewrites a decision in flight.
 *  - **`resolved_config` snapshots the decision points that were in force** at
 *    `occurred_at` (ADR-0016 reproducibility, ADR-0012 snapshot-on-use). The
 *    config store can answer "what is the value now"; only this column answers
 *    "what value did *this* transition act on".
 *
 * `workflow_transition` deviates from the ADR-0011 standard columns exactly as
 * `platform.domain_event` does, and for the same reason: it is append-only, so
 * it carries no `updated_at`/`deleted_at`, and it splits time into `occurred_at`
 * (business time, passed in — ADR-0009) and `recorded_at` (insert time), the
 * latter playing the `created_at` role.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- platform.workflow_instance -----------------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.workflow_instance')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side (ADR-0011)
      // The definition key, e.g. 'platform.demo.request', later 'hr.leave.approval'.
      .addColumn('workflow_key', 'text', (c) => c.notNull())
      .addColumn('definition_version', 'integer', (c) => c.notNull()) // pinned at start (WF-4)
      // What the case is *about*, named the same way the journal names streams
      // (ADR-0021 `<module>.<entity>`), so an instance and its events line up.
      .addColumn('subject_stream_type', 'text', (c) => c.notNull())
      .addColumn('subject_stream_id', 'uuid', (c) => c.notNull())
      // Free text by design — see the header note on why there is no CHECK here.
      .addColumn('current_state', 'text', (c) => c.notNull())
      // Set on entering a terminal state; also what makes an instance eligible to
      // repeat for the same subject (a second probation review, say).
      .addColumn('completed_at', 'timestamptz'),
    { actorStamps: false },
  )
    // NOT NULL: an instance is always started by owning-domain code on behalf of
    // a real actor (§5.2 `startWorkflow`). System *transitions* exist (timers);
    // system *starts* do not, and the FK keeps that honest.
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint(
      'workflow_instance_created_by_fkey',
      ['created_by'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'workflow_instance_updated_by_fkey',
      ['updated_by'],
      'platform.person',
      ['id'],
    )
    .addCheckConstraint('workflow_instance_version_chk', sql`definition_version >= 1`)
    .execute();

  await sql`
    COMMENT ON TABLE platform.workflow_instance IS
      'One running (or completed) case of a workflow definition (ADR-0013, WF-4/WF-5). current_state is validated by the runtime against the pinned definition_version, not by a CHECK — the legal state set is per-definition data.'
  `.execute(db);

  // One ACTIVE instance of a given workflow per subject. Completed ones may
  // repeat, which is why `completed_at IS NULL` is in the predicate rather than
  // the index being unconditional.
  await sql`
    CREATE UNIQUE INDEX workflow_instance_active_subject_uq
      ON platform.workflow_instance (workflow_key, subject_stream_type, subject_stream_id)
      WHERE completed_at IS NULL AND deleted_at IS NULL
  `.execute(db);

  // "Show me every workflow touching this record" — the subject-centric read.
  await db.schema
    .createIndex('workflow_instance_subject_idx')
    .on('platform.workflow_instance')
    .columns(['subject_stream_type', 'subject_stream_id'])
    .execute();

  // The admin list's working set: open cases by key and state.
  await sql`
    CREATE INDEX workflow_instance_key_state_idx
      ON platform.workflow_instance (workflow_key, current_state)
      WHERE completed_at IS NULL
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.workflow_instance');

  // --- platform.workflow_transition (append-only) -------------------------
  await db.schema
    .createTable('platform.workflow_transition')
    .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
    .addColumn('instance_id', 'uuid', (c) => c.notNull())
    .addColumn('from_state', 'text', (c) => c.notNull())
    .addColumn('to_state', 'text', (c) => c.notNull())
    .addColumn('action', 'text', (c) => c.notNull()) // the named transition taken
    .addColumn('actor_person_id', 'uuid') // NULL = system (timer/automation)
    .addColumn('on_behalf_of', 'uuid') // HR acting for an employee (ADR-0011)
    .addColumn('comment', 'text') // e.g. a rejection reason
    // [{ guard, outcome: 'pass' | 'warn', detail? }] — the soft-warning evidence
    // PL-017 consumers read back ("approved despite a clash, and here it is").
    .addColumn('guard_results', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    // The `config:` references resolved as-at `occurred_at` (ADR-0016/0012).
    .addColumn('resolved_config', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    // [{ name, params }] — what was handed to the effects queue by the relay.
    .addColumn('effects', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('occurred_at', 'timestamptz', (c) => c.notNull()) // business time, passed in
    .addColumn('recorded_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`)) // insert time
    .addColumn('created_by', 'uuid') // = actor_person_id, or NULL for system
    .addForeignKeyConstraint(
      'workflow_transition_instance_fkey',
      ['instance_id'],
      'platform.workflow_instance',
      ['id'],
    )
    .addForeignKeyConstraint(
      'workflow_transition_actor_fkey',
      ['actor_person_id'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'workflow_transition_on_behalf_of_fkey',
      ['on_behalf_of'],
      'platform.person',
      ['id'],
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.workflow_transition IS
      'Append-only transition log (ADR-0011/0012, WF-5/WF-11): every state change with its actor, guard results and the config values in force at occurred_at. Immutable at the database level.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.workflow_transition.resolved_config IS
      'The config: references this transition acted on, resolved as-at occurred_at (ADR-0016). Ids and primitive decision values only — never subject profile data (ADR-0019).'
  `.execute(db);

  // The instance timeline, which is the only way this table is read.
  await db.schema
    .createIndex('workflow_transition_instance_idx')
    .on('platform.workflow_transition')
    .columns(['instance_id', 'occurred_at'])
    .execute();

  // ADR-0011: immutability is a database property, not an application promise.
  // The generic guard suffices — unlike the journal, a transition row has no
  // legal post-insert mutation at all.
  await makeAppendOnly(db, 'platform.workflow_transition');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.workflow_transition').ifExists().execute();
  await db.schema.dropTable('platform.workflow_instance').ifExists().execute();
}
