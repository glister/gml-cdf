import { Kysely, sql } from 'kysely';
import { attachUpdatedAtTrigger, withStandardColumns } from '../migration-helpers.js';

/**
 * Core plan 07 §4.1 (ADR-0013, WF-8/WF-9): `platform.scheduled_action` — every
 * timer the platform holds, in Postgres rather than in the broker.
 *
 * ADR-0013 chose DB-backed timers over Service Bus `scheduledEnqueueTime` for
 * one reason: a pending timer must be **queryable, amendable and cancellable**.
 * "Which reminders are outstanding for this case, and cancel them" is a SQL
 * statement here; against a broker it is not expressible at all. The cost is a
 * cron Job that drains due rows (`apps/worker/src/scheduler.ts`), which bounds
 * firing latency to the cron cadence — acceptable because every Phase 1 cadence
 * is day-granular (fit-note chase, probation lead times, access expiry).
 *
 * History class (ADR-0012): **"everything else" → `updated_at` + journal
 * events.** This table is deliberately *not* append-only: it is operational
 * state, and `status` genuinely moves (`pending → enqueued → executed`,
 * `pending → cancelled`) while `due_at` is amendable while pending. Its history
 * lives in the `platform.workflow.timer.*` journal events, which is where an
 * auditor looks.
 *
 * `id` doubles as the Service Bus `MessageId` (`sa:{id}`), so broker duplicate
 * detection is the first idempotency layer and the executed-guard
 * (`status = 'enqueued'` on the marking UPDATE) is the second and real one.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await withStandardColumns(
    db.schema
      .createTable('platform.scheduled_action')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7; also the MessageId
      .addColumn('due_at', 'timestamptz', (c) => c.notNull())
      // An effect-registry name — 'workflow.transition' (built in here),
      // 'notification.reminder' (plan 10), 'platform.identity.access-expiry-sweep'
      // (plan 03). Not CHECK-constrained: the registry is code that grows per
      // plan, and an unknown name dead-letters loudly at execution instead.
      .addColumn('action_type', 'text', (c) => c.notNull())
      // PII-minimal: ids and parameters only (ADR-0019).
      .addColumn('payload', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
      // What the timer is *about* — the queryability half of WF-9.
      .addColumn('subject_stream_type', 'text')
      .addColumn('subject_stream_id', 'uuid')
      .addColumn('workflow_instance_id', 'uuid') // NULL for non-workflow timers
      .addColumn('status', 'text', (c) =>
        c
          .notNull()
          .defaultTo('pending')
          .check(sql`status IN ('pending', 'enqueued', 'executed', 'cancelled')`),
      )
      .addColumn('enqueued_at', 'timestamptz')
      .addColumn('executed_at', 'timestamptz')
      .addColumn('cancelled_at', 'timestamptz')
      .addColumn('cancel_reason', 'text')
      // Who created the timer. CHECK-constrained (a §4.3 deviation, see the plan
      // change log): the plan's DDL comment already declares a closed set, and an
      // unconstrained provenance column is the loose flag WF-11 forbids.
      .addColumn('source', 'text', (c) =>
        c.notNull().check(sql`source IN ('workflow', 'manual', 'system')`),
      ),
    { actorStamps: false },
  )
    .addColumn('created_by', 'uuid') // NULL = system (the scheduler, a sweep)
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint(
      'scheduled_action_instance_fkey',
      ['workflow_instance_id'],
      'platform.workflow_instance',
      ['id'],
    )
    .addForeignKeyConstraint(
      'scheduled_action_created_by_fkey',
      ['created_by'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'scheduled_action_updated_by_fkey',
      ['updated_by'],
      'platform.person',
      ['id'],
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.scheduled_action IS
      'DB-backed timers (ADR-0013, WF-8/WF-9): pending rows are queryable, amendable and cancellable in SQL. Drained by the scheduler cron Job onto the effects queue; execution is idempotent. Not append-only — operational state, with its history in the platform.workflow.timer.* journal events.'
  `.execute(db);

  // The scheduler's working index — the only hot path this table has, and tiny
  // because it covers pending rows alone.
  await sql`
    CREATE INDEX scheduled_action_due_idx
      ON platform.scheduled_action (due_at) WHERE status = 'pending'
  `.execute(db);

  // "What is outstanding for this record?" — used by consumers cancelling a
  // subject's timers (e.g. an absence closing out its fit-note chase).
  await sql`
    CREATE INDEX scheduled_action_subject_idx
      ON platform.scheduled_action (subject_stream_type, subject_stream_id)
      WHERE status = 'pending'
  `.execute(db);

  // Terminal-state auto-cancellation reads exactly this predicate (§5.2 step 6).
  await sql`
    CREATE INDEX scheduled_action_instance_idx
      ON platform.scheduled_action (workflow_instance_id) WHERE status = 'pending'
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.scheduled_action');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.scheduled_action').ifExists().execute();
}
