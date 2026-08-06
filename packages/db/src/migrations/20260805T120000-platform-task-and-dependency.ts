import { Kysely, sql } from 'kysely';
import { attachUpdatedAtTrigger, withStandardColumns } from '../migration-helpers.js';

/**
 * Core plan 08 §4.1 (PL-013/PL-014, ADR-0011/0012): `platform.task` and
 * `platform.task_dependency` — the one task table every multi-step, multi-party
 * process in the platform runs on.
 *
 * The point of the design is what is **absent**. There is no
 * `assignee_person_id`: a task points at a role, and "whose task is this?" is a
 * join against `platform.role_grant` at read time (PL-014). Changing a role's
 * membership therefore redirects task lists and future notifications with **zero
 * writes to task rows** — reassignment is not an operation, it is a consequence
 * of the model (ON AC-5). And there is no `is_blocked`/`is_done` pair: `status`
 * is a literal union with guarded transitions (§6 principle 7).
 *
 * History class (ADR-0012): **process state.** The task row is current state;
 * every raise/unblock/claim/complete/cancel is a `platform.task.*` journal event
 * appended in the same transaction (ADR-0010), so the row is reconstructable
 * from the trail. Soft delete only.
 *
 * Three column choices are worth their ink:
 *
 *  - **`stream_type`/`stream_id` name the case the same way the journal names
 *    streams** (ADR-0021 `<module>.<entity>`), so a case's tasks and a case's
 *    events line up without a mapping table. `lane` and `gate_key` are
 *    deliberately opaque `text`: their vocabularies belong to the raising
 *    definition, not to this table, which is what stops the HR plans from
 *    growing their own task tables "for just one extra column" (§12.3).
 *  - **The due model keeps the spec *and* the resolved value.** An
 *    anchor-relative task stores `anchor_name` + `anchor_offset_days` alongside
 *    `due_at`, so when the anchor moves (a start date changes) the resolution is
 *    re-runnable rather than lost — which is the whole of PL-013's second half.
 *  - **`claimed_by` is metadata, not a state.** It signals "being worked"; it
 *    never gates completion by another member of the role, because a role is the
 *    unit of assignment and a claim that excluded colleagues would quietly
 *    reintroduce named-individual assignment.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- platform.task --------------------------------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.task')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side (ADR-0011)
      // The case this task belongs to, in journal stream vocabulary — e.g.
      // ('hr.onboarding_case', <case id>) or ('platform.pilot_case', <subject>).
      .addColumn('stream_type', 'text', (c) => c.notNull())
      .addColumn('stream_id', 'uuid', (c) => c.notNull())
      .addColumn('workflow_instance_id', 'uuid') // NULL for manual tasks
      // Grouping label for dashboards ('it', 'transport', 'hr', …). Free text:
      // lane vocabularies are definition data, not schema.
      .addColumn('lane', 'text')
      // Instructions, never personal data (§8 content rule, ADR-0015/0019). A
      // task references its subject through the stream; it never restates it.
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('description', 'text')
      // Assignment IS the role (PL-014). There is no person FK for assignment.
      .addColumn('assignee_role_id', 'uuid', (c) => c.notNull())
      .addColumn('claimed_by', 'uuid') // optional working-claim, not a state
      .addColumn('claimed_at', 'timestamptz')
      // Due model (PL-013): 'none' | 'absolute' | 'anchor_relative'.
      .addColumn('due_mode', 'text', (c) =>
        c
          .notNull()
          .defaultTo('none')
          .check(sql`due_mode IN ('none', 'absolute', 'anchor_relative')`),
      )
      .addColumn('anchor_name', 'text') // e.g. 'start_date'
      .addColumn('anchor_offset_days', 'integer') // signed; start_date − 3d ⇒ -3
      .addColumn('due_at', 'timestamptz') // the resolved value, both modes
      .addColumn('status', 'text', (c) =>
        c
          .notNull()
          .defaultTo('open')
          .check(sql`status IN ('blocked', 'open', 'done', 'cancelled')`),
      )
      // Provenance: raised by a workflow effect, or created by hand (PL-013).
      .addColumn('source', 'text', (c) => c.notNull().check(sql`source IN ('workflow', 'manual')`))
      .addColumn('source_ref', 'text') // e.g. 'platform.pilot.checklist@1#it_setup'
      .addColumn('completed_by', 'uuid')
      .addColumn('completed_at', 'timestamptz')
      .addColumn('completion_note', 'text')
      .addColumn('cancel_reason', 'text'),
    { actorStamps: false },
  )
    // NULL = system actor: a task list raised by a timer-fired transition has no
    // person behind it, and the effects queue carries ids only (ADR-0019). The
    // authoritative actor is the journal event's `actor_person_id` either way.
    .addColumn('created_by', 'uuid')
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint('task_assignee_role_fkey', ['assignee_role_id'], 'platform.role', [
      'id',
    ])
    .addForeignKeyConstraint('task_claimed_by_fkey', ['claimed_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('task_completed_by_fkey', ['completed_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('task_created_by_fkey', ['created_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint('task_updated_by_fkey', ['updated_by'], 'platform.person', ['id'])
    .addForeignKeyConstraint(
      'task_workflow_instance_fkey',
      ['workflow_instance_id'],
      'platform.workflow_instance',
      ['id'],
    )
    // The due model's three shapes, each fully constrained: an absolute due date
    // carries no anchor, an anchor-relative one carries both halves *and* its
    // resolved value, and 'none' carries nothing. Without these a row could claim
    // to be anchor-relative while holding no anchor to re-resolve from.
    .addCheckConstraint(
      'task_due_absolute_chk',
      sql`due_mode <> 'absolute' OR (due_at IS NOT NULL AND anchor_name IS NULL AND anchor_offset_days IS NULL)`,
    )
    .addCheckConstraint(
      'task_due_anchor_chk',
      sql`due_mode <> 'anchor_relative' OR (anchor_name IS NOT NULL AND anchor_offset_days IS NOT NULL AND due_at IS NOT NULL)`,
    )
    .addCheckConstraint(
      'task_due_none_chk',
      sql`due_mode <> 'none' OR (due_at IS NULL AND anchor_name IS NULL AND anchor_offset_days IS NULL)`,
    )
    // `done` and its completion metadata are the same fact; neither can exist
    // without the other.
    .addCheckConstraint(
      'task_done_metadata_chk',
      sql`(status = 'done') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)`,
    )
    .addCheckConstraint('task_claim_pair_chk', sql`(claimed_by IS NULL) = (claimed_at IS NULL)`)
    .execute();

  await sql`
    COMMENT ON TABLE platform.task IS
      'The generic task/checklist engine (PL-013/014). Assigned to a ROLE, never a person — membership resolves at read and send time, so reassignment needs no writes here. Process state (ADR-0012): history lives in the platform.task.* journal events.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.task.title IS
      'Instructions, never personal or special-category data (ADR-0015/0019). The task links to its record; the record enforces field-level RBAC.'
  `.execute(db);

  // Case dashboard reads (PL-015) — `caseProgress` groups on exactly this.
  await sql`
    CREATE INDEX task_stream_idx
      ON platform.task (stream_type, stream_id) WHERE deleted_at IS NULL
  `.execute(db);

  // My-tasks: role resolution + the keyset's leading columns (PL-014).
  await sql`
    CREATE INDEX task_role_status_due_idx
      ON platform.task (assignee_role_id, status, due_at, id) WHERE deleted_at IS NULL
  `.execute(db);

  // The overdue chase — the reminder sweep's and the dashboard's shared predicate.
  await sql`
    CREATE INDEX task_overdue_idx
      ON platform.task (due_at)
      WHERE status IN ('blocked', 'open') AND deleted_at IS NULL
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.task');

  // --- platform.task_dependency --------------------------------------------
  //
  // A row blocks its `task_id` until `satisfied_at` is stamped. Two kinds:
  // `task` (another task in the case reaching a terminal state) and `gate` (a
  // named, case-scoped condition opened by a workflow effect). The gate kind is
  // what makes "the verification gate blocks only the steps that depend on it"
  // (ON-033) expressible without any onboarding vocabulary in this table.
  await withStandardColumns(
    db.schema
      .createTable('platform.task_dependency')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('task_id', 'uuid', (c) => c.notNull())
      .addColumn('depends_on_kind', 'text', (c) =>
        c.notNull().check(sql`depends_on_kind IN ('task', 'gate')`),
      )
      .addColumn('depends_on_task_id', 'uuid')
      .addColumn('gate_key', 'text') // scoped to the task's stream
      .addColumn('satisfied_at', 'timestamptz'), // NULL = still blocking
    { updatedAt: false, softDelete: false, actorStamps: false },
  )
    .addColumn('created_by', 'uuid')
    .addForeignKeyConstraint('task_dependency_task_fkey', ['task_id'], 'platform.task', ['id'])
    .addForeignKeyConstraint(
      'task_dependency_depends_on_fkey',
      ['depends_on_task_id'],
      'platform.task',
      ['id'],
    )
    .addForeignKeyConstraint('task_dependency_created_by_fkey', ['created_by'], 'platform.person', [
      'id',
    ])
    .addCheckConstraint(
      'task_dependency_task_shape_chk',
      sql`(depends_on_kind = 'task') = (depends_on_task_id IS NOT NULL)`,
    )
    .addCheckConstraint(
      'task_dependency_gate_shape_chk',
      sql`(depends_on_kind = 'gate') = (gate_key IS NOT NULL)`,
    )
    .addCheckConstraint(
      'task_dependency_no_self_chk',
      sql`depends_on_task_id IS DISTINCT FROM task_id`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.task_dependency IS
      'Edges that block a task: another task reaching a terminal state, or a named case-scoped gate opening. Rows are SATISFIED (satisfied_at stamped), never deleted — the record of what blocked what survives.'
  `.execute(db);

  // `NULLS NOT DISTINCT` is the point: a gate edge has a NULL depends_on_task_id
  // and a task edge a NULL gate_key, and the default NULL-distinct semantics
  // would let either be inserted twice over.
  await sql`
    ALTER TABLE platform.task_dependency
      ADD CONSTRAINT task_dependency_uq
      UNIQUE NULLS NOT DISTINCT (task_id, depends_on_task_id, gate_key)
  `.execute(db);

  // "Which tasks does completing X unlock?" — the reverse edge the unlock path
  // walks on every completion.
  await sql`
    CREATE INDEX task_dependency_reverse_idx
      ON platform.task_dependency (depends_on_task_id) WHERE satisfied_at IS NULL
  `.execute(db);

  // Gate satisfaction: candidate rows by key, then narrowed to the stream by a
  // join through the task (a gate is case-scoped, and this table has no stream
  // column of its own — the task it blocks already carries it).
  await sql`
    CREATE INDEX task_dependency_gate_idx
      ON platform.task_dependency (gate_key) WHERE satisfied_at IS NULL
  `.execute(db);

  // "What still blocks this task?" — the detail panel's read, and the
  // unsatisfied-count check the unlock path runs per dependent.
  await sql`
    CREATE INDEX task_dependency_task_idx
      ON platform.task_dependency (task_id) WHERE satisfied_at IS NULL
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.task_dependency').ifExists().execute();
  await db.schema.dropTable('platform.task').ifExists().execute();
}
