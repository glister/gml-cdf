import { Kysely, sql } from 'kysely';
import {
  attachUpdatedAtTrigger,
  makeAppendOnly,
  withStandardColumns,
} from '../migration-helpers.js';

/**
 * Core plan 09 §4.2 (PL-016…018, ADR-0011/0012/0022): the four tables of the
 * approval engine — the one place in the platform a sign-off is recorded, and
 * the reason no consumer ever grows an `approved boolean` of its own.
 *
 * ## What the shape asserts
 *
 * **The policy is the authorisation source; these rows are not** (§4.5). There
 * is no "approver" column on the request, and `approval_assignee` is explicitly
 * *the notification record*: who the policy resolved to at submit, how, and
 * whether they were told. Authority is re-resolved live at decide time, so a
 * membership change redirects a pending request with **zero writes here**
 * (PL-021 / ON AC-5) — the same property `platform.task` gets from assigning to
 * a role rather than a person.
 *
 * **First decision wins, structurally.** `approval_request.status` moves out of
 * `'pending'` under a compare-and-set, and
 * `approval_decision_one_per_request` is the database's backstop: even a caller
 * that bypassed the service could not write a second decision. Combined with
 * `approval_request_one_pending_per_subject`, "at most one open sign-off per
 * subject, decided at most once" is a schema property rather than an
 * application promise.
 *
 * **A rejection without a reason is impossible** (PL-016). The Zod schema
 * refuses it at the API boundary and `approval_decision_reason_chk` refuses it
 * at the database, so the guarantee survives a direct SQL insert.
 *
 * History class (ADR-0012): the request is **process state** — current status on
 * the row, every change a `platform.approval_request.*` journal event appended
 * in the same transaction (ADR-0010). The decision is a **business fact** and is
 * therefore append-only at the database level (`makeAppendOnly`): a decision,
 * once made, is never edited or withdrawn. A change of mind is a new request.
 *
 * Two nullability choices differ from the plan's §4.2 sketch, both recorded in
 * that section's change log:
 *
 *  - **`requested_by` is nullable.** A workflow-bound request opened by a
 *    timer-fired transition has no person behind it — the same reason
 *    `platform.task.created_by` is nullable (core plan 08). NULL means
 *    system-raised, and the requester notification simply has nobody to reach.
 *  - **`policy_version` is nullable.** `resolveConfig` returns `version: null`
 *    when no entry has ever been written and the *registered code default* was
 *    in force. Defaults are frozen once shipped (`@repo/config`), so NULL is
 *    exactly as reproducible as an integer — it names the default rather than
 *    pretending a version row existed.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- platform.approval_request --------------------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.approval_request')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side (ADR-0011)
      // The business record this sign-off is about, in journal stream
      // vocabulary (ADR-0021) — e.g. ('hr.leave_booking', <booking id>) or
      // ('platform.pilot_signoff', <subject id>). Opaque `text` on purpose: the
      // vocabulary belongs to the consuming module, which is what stops each of
      // them growing an approval table "for just one extra column".
      .addColumn('subject_type', 'text', (c) => c.notNull())
      .addColumn('subject_id', 'uuid', (c) => c.notNull())
      // NULL for a standalone sign-off — the second entry point (§5.5), which is
      // what keeps a document-change approval from needing a workflow shape.
      .addColumn('workflow_instance_id', 'uuid')
      // The runtime action the decisive approval fires; rejection fires the
      // definition's reject action. Meaningless without an instance (CHECK below).
      .addColumn('workflow_action', 'text')
      // NULL = system-raised (a timer-fired transition opened it).
      .addColumn('requested_by', 'uuid')
      // The config key whose value decided who may act. The *key*, not the
      // resolved people: authority is re-resolved live (§4.5).
      .addColumn('policy_key', 'text', (c) => c.notNull())
      // The config_entry version in force at submit; NULL = the frozen code
      // default. An audit snapshot only — never read to authorise.
      .addColumn('policy_version', 'integer')
      // PII-minimal facts for warning providers and threshold rules: ids, dates,
      // amounts. Never names or free text (ADR-0019) — a provider needing detail
      // reads it live under its own RBAC.
      .addColumn('context', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('status', 'text', (c) =>
        c
          .notNull()
          .defaultTo('pending')
          .check(sql`status IN ('pending', 'approved', 'rejected', 'cancelled')`),
      )
      .addColumn('decided_at', 'timestamptz'),
    { actorStamps: false },
  )
    // NULL = system actor, for the same reason `requested_by` is nullable: a
    // request opened by a timer-fired transition has no person behind it.
    .addColumn('created_by', 'uuid')
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint(
      'approval_request_workflow_instance_fkey',
      ['workflow_instance_id'],
      'platform.workflow_instance',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_request_requested_by_fkey',
      ['requested_by'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_request_created_by_fkey',
      ['created_by'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_request_updated_by_fkey',
      ['updated_by'],
      'platform.person',
      ['id'],
    )
    .addCheckConstraint(
      'approval_request_workflow_action_chk',
      sql`workflow_action IS NULL OR workflow_instance_id IS NOT NULL`,
    )
    // A decided request has a decision instant and a pending one does not —
    // neither half can drift from the other.
    .addCheckConstraint(
      'approval_request_decided_at_chk',
      sql`(status = 'pending') = (decided_at IS NULL)`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.approval_request IS
      'One sign-off sought (PL-016). The policy_key — not a resolved approver set — is the authorisation source: eligibility is re-resolved live at decide time, so a role membership change redirects a pending request with no writes here (PL-021).'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.approval_request.context IS
      'PII-minimal facts for warning providers and threshold rules: ids, dates, amounts (ADR-0019). Never names or free text — a provider needing detail reads it live under its own RBAC.'
  `.execute(db);

  // "Show me this booking's approvals" — the record panel's read.
  await sql`
    CREATE INDEX approval_request_subject_idx
      ON platform.approval_request (subject_type, subject_id) WHERE deleted_at IS NULL
  `.execute(db);

  // The inbox's leading columns: the outstanding set, in keyset order.
  await sql`
    CREATE INDEX approval_request_pending_idx
      ON platform.approval_request (created_at, id)
      WHERE status = 'pending' AND deleted_at IS NULL
  `.execute(db);

  // At most one live request per subject. This is what makes the `approval.open`
  // effect idempotent under redelivery without a claim ledger of its own: the
  // second open is absorbed by the database (§5.5).
  await sql`
    CREATE UNIQUE INDEX approval_request_one_pending_per_subject
      ON platform.approval_request (subject_type, subject_id)
      WHERE status = 'pending' AND deleted_at IS NULL
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.approval_request');

  // --- platform.approval_delegation -----------------------------------------
  //
  // Created before `approval_assignee` and `approval_decision`, which both
  // reference it. A standing delegation ("X delegates to Y for a period") is
  // per-person effective-dated relational data that exists independently of any
  // request — it cannot honestly live inside the per-request assignee table, nor
  // as a config blob, because it points at people and needs FK integrity (the
  // same reasoning ADR-0016 applies to `platform.team`). Inventory addition,
  // attributed to plan 09 in implementation notes §6.
  await withStandardColumns(
    db.schema
      .createTable('platform.approval_delegation')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('delegator_person_id', 'uuid', (c) => c.notNull())
      .addColumn('delegate_person_id', 'uuid', (c) => c.notNull())
      // NULL = every subject type. A scoped delegation covers one kind of
      // sign-off ("approve my leave requests while I'm away"), which is what
      // lets an approver hand over less than all of their authority.
      .addColumn('subject_type', 'text')
      .addColumn('valid_from', 'timestamptz', (c) => c.notNull())
      .addColumn('valid_to', 'timestamptz', (c) => c.notNull())
      // Early revocation is non-destructive: the window stays on the row, so a
      // decision already made under it stays explainable.
      .addColumn('revoked_at', 'timestamptz')
      .addColumn('reason', 'text'),
    { actorStamps: false },
  )
    // A delegation is always arranged by a person — the approver themselves, or
    // an administrator covering for them. There is no system path to one.
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('updated_by', 'uuid', (c) => c.notNull())
    .addForeignKeyConstraint(
      'approval_delegation_delegator_fkey',
      ['delegator_person_id'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_delegation_delegate_fkey',
      ['delegate_person_id'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_delegation_created_by_fkey',
      ['created_by'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_delegation_updated_by_fkey',
      ['updated_by'],
      'platform.person',
      ['id'],
    )
    // Delegating to yourself is a no-op that would silently double an approver's
    // rows in every resolution.
    .addCheckConstraint(
      'approval_delegation_distinct_chk',
      sql`delegate_person_id <> delegator_person_id`,
    )
    .addCheckConstraint('approval_delegation_window_chk', sql`valid_to > valid_from`)
    .execute();

  await sql`
    COMMENT ON TABLE platform.approval_delegation IS
      'Standing delegations of approval authority (HL-035 driver). Honoured at resolution time, never copied onto a request. Revoked by stamping revoked_at — never deleted, so a decision made under a delegation stays explainable.'
  `.execute(db);

  // The resolver's read: "whose authority does this person currently carry?"
  await sql`
    CREATE INDEX approval_delegation_active_idx
      ON platform.approval_delegation (delegator_person_id, valid_from, valid_to)
      WHERE revoked_at IS NULL AND deleted_at IS NULL
  `.execute(db);

  // The inbox's read, from the other end: "whose requests can I act on?"
  await sql`
    CREATE INDEX approval_delegation_delegate_idx
      ON platform.approval_delegation (delegate_person_id, valid_from, valid_to)
      WHERE revoked_at IS NULL AND deleted_at IS NULL
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.approval_delegation');

  // --- platform.approval_assignee -------------------------------------------
  //
  // Who the policy resolved to AT REQUEST TIME, and whether they were told.
  // **Not the authorisation source** (§4.5) — that is the policy, re-resolved
  // live. This table answers "who was asked?", forever, which live resolution
  // by construction cannot.
  await withStandardColumns(
    db.schema
      .createTable('platform.approval_assignee')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('request_id', 'uuid', (c) => c.notNull())
      .addColumn('person_id', 'uuid', (c) => c.notNull())
      // How this person came to be asked — the provenance an audit needs to
      // explain a notification list a year later.
      //
      // There is no 'policy_person': a policy value may not name an individual
      // (plan 06 §4.5 — configuration references roles, membership resolves at
      // use time, PL-021). A named individual reaches a request either through
      // a role, or through a `designated` resolver reading a table with a real
      // person FK — which end-dates when they leave and which plan 16's erasure
      // sweep can find. Recorded in plan 09 §4.5's change log.
      .addColumn('source', 'text', (c) =>
        c.notNull().check(sql`source IN ('policy_role', 'designated', 'delegation')`),
      )
      .addColumn('source_role_id', 'uuid')
      .addColumn('delegation_id', 'uuid')
      // Stamped by the platform.notification.sent subscription (§5.2); NULL
      // until the send lands, which is honest about an outbox that has not
      // drained rather than asserting a notification that has not happened.
      .addColumn('notified_at', 'timestamptz'),
    { updatedAt: false, softDelete: false, actorStamps: false },
  )
    .addColumn('created_by', 'uuid')
    .addForeignKeyConstraint(
      'approval_assignee_request_fkey',
      ['request_id'],
      'platform.approval_request',
      ['id'],
    )
    .addForeignKeyConstraint('approval_assignee_person_fkey', ['person_id'], 'platform.person', [
      'id',
    ])
    .addForeignKeyConstraint('approval_assignee_role_fkey', ['source_role_id'], 'platform.role', [
      'id',
    ])
    .addForeignKeyConstraint(
      'approval_assignee_delegation_fkey',
      ['delegation_id'],
      'platform.approval_delegation',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_assignee_created_by_fkey',
      ['created_by'],
      'platform.person',
      ['id'],
    )
    // Each source carries exactly the provenance it claims: a role-resolved
    // assignee names the role, a delegated one names the delegation. Without
    // these a row could say 'policy_role' while pointing at nothing.
    .addCheckConstraint(
      'approval_assignee_role_shape_chk',
      sql`(source = 'policy_role') = (source_role_id IS NOT NULL)`,
    )
    .addCheckConstraint(
      'approval_assignee_delegation_shape_chk',
      sql`(source = 'delegation') = (delegation_id IS NOT NULL)`,
    )
    // One row per person per request: the reminder subscription adds
    // send-time arrivals (§4.5) and must be able to do so idempotently.
    .addUniqueConstraint('approval_assignee_uq', ['request_id', 'person_id'])
    .execute();

  await sql`
    COMMENT ON TABLE platform.approval_assignee IS
      'The notification record: who the policy resolved to at submit, how, and whether they were told. NOT the authorisation source — eligibility is re-resolved live at decide time (plan 09 §4.5).'
  `.execute(db);

  // The request-detail read ("who was asked?").
  await sql`
    CREATE INDEX approval_assignee_request_idx ON platform.approval_assignee (request_id)
  `.execute(db);

  // --- platform.approval_decision -------------------------------------------
  //
  // The decisive decision, and the only one there will ever be. Append-only at
  // the database level (ADR-0011): a decision is a business fact, and a system
  // whose approvals can be edited afterwards has no audit trail worth the name.
  await withStandardColumns(
    db.schema
      .createTable('platform.approval_decision')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('request_id', 'uuid', (c) => c.notNull())
      .addColumn('decision', 'text', (c) =>
        c.notNull().check(sql`decision IN ('approved', 'rejected')`),
      )
      .addColumn('actor_person_id', 'uuid', (c) => c.notNull())
      // Set when the actor's authority came via a delegation, so "who actually
      // approved this, and on whose behalf?" is answerable from the row.
      .addColumn('delegation_id', 'uuid')
      // Mandatory on rejection (CHECK below). Free text, and it stays HERE — the
      // journal payload carries only `hasReason` (ADR-0019).
      .addColumn('reason', 'text')
      // `[{ provider, code }]` — codes only, never the rendered warning text.
      // What the decider was shown and acknowledged, which is the audit question
      // PL-017 actually asks.
      .addColumn('warnings_acknowledged', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('decided_at', 'timestamptz', (c) => c.notNull()),
    { updatedAt: false, softDelete: false, actorStamps: false },
  )
    .addColumn('created_by', 'uuid')
    .addForeignKeyConstraint(
      'approval_decision_request_fkey',
      ['request_id'],
      'platform.approval_request',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_decision_actor_fkey',
      ['actor_person_id'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_decision_delegation_fkey',
      ['delegation_id'],
      'platform.approval_delegation',
      ['id'],
    )
    .addForeignKeyConstraint(
      'approval_decision_created_by_fkey',
      ['created_by'],
      'platform.person',
      ['id'],
    )
    // PL-016's mandatory rejection reason, braces to the Zod schema's belt: a
    // direct SQL insert bypassing the API is refused here.
    .addCheckConstraint(
      'approval_decision_reason_chk',
      sql`decision <> 'rejected' OR (reason IS NOT NULL AND length(trim(reason)) > 0)`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.approval_decision IS
      'The one decisive decision per request (PL-016, any-one-approves). Append-only: a decision is a business fact and is never edited or withdrawn — a change of mind is a new request.'
  `.execute(db);

  // First decision wins, at the database. The compare-and-set on
  // approval_request.status is the fast path; this is what holds if anything
  // ever reaches the table another way.
  await sql`
    CREATE UNIQUE INDEX approval_decision_one_per_request
      ON platform.approval_decision (request_id)
  `.execute(db);

  await makeAppendOnly(db, 'platform.approval_decision');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.approval_decision').ifExists().execute();
  await db.schema.dropTable('platform.approval_assignee').ifExists().execute();
  await db.schema.dropTable('platform.approval_delegation').ifExists().execute();
  await db.schema.dropTable('platform.approval_request').ifExists().execute();
}
