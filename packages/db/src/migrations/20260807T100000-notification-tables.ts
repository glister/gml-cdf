import { Kysely, sql } from 'kysely';
import { attachUpdatedAtTrigger, withStandardColumns } from '../migration-helpers.js';

/**
 * Core plan 10 §4.2/§4.3 (PL-019…021, ADR-0011/0012/0019): the two tables of the
 * notification service — the logical message, and one row per channel attempt
 * per resolved recipient.
 *
 * ## What the shape asserts
 *
 * **There is no `recipient_person_id` column, and that is the requirement**
 * (PL-021). A notification names a *role*, an *approver policy* or a
 * *contextual reference to its own subject*; the people are resolved at send
 * time and appear only on delivery rows. Changing a role's membership therefore
 * redirects every future send with **zero writes here and no reconfiguration**
 * anywhere — the same property `platform.task` gets from assigning to a role and
 * `platform.approval_request` gets from re-resolving its policy. A column for a
 * person would make that property optional, and optional is how it gets lost.
 *
 * `notification_recipient_shape` is what stops the three-way union degrading
 * into "three nullable columns, fill in whichever": exactly one shape is
 * populated, checked by the database rather than by the service that writes it.
 *
 * **Read state is per recipient, so it lives on the delivery row.** One
 * role-addressed notification fans out to everyone holding the role, each with
 * their own unread state; `read_at` on the message would be a single bit shared
 * by a dozen people.
 *
 * **A delivery is recorded even when it is not attempted.** A channel disabled
 * in configuration produces a `suppressed` row rather than nothing at all, so
 * "why didn't I get an email?" is answerable from the table instead of from an
 * absence (AC-D8). Terminal failures stay as `dead` rows with their
 * `last_error` and `attempt_count` — the delivery history accumulates rather
 * than being overwritten by the next attempt (ADR-0012).
 *
 * **`delivery_once_per_person_channel` is the idempotency backstop.** Effect
 * delivery is at-least-once, so `notification.dispatch` will run twice; the
 * unique constraint is what makes the second run's `ON CONFLICT DO NOTHING`
 * a structural no-op rather than an application promise (§5.6).
 *
 * History class (ADR-0012): both tables are **operational state** — statuses and
 * read-marks mutate in place, and the business facts (`requested`, `sent`,
 * `delivery_failed`, `unresolved`) are journal events appended in the same
 * transaction as the write (ADR-0010). Neither is append-only: a delivery row
 * that could not be updated could not record its own retry.
 *
 * Three deviations from the plan's §4.2/§4.3 sketch, all recorded in that
 * section's change log:
 *
 *  - **`updated_by` is present on both tables** (the sketch listed only
 *    `created_by`). ADR-0011's actor stamps come in pairs, and a mark-read is an
 *    update by a person — dropping the column would lose the only stamp saying
 *    which one.
 *  - **`channels` is CHECK-constrained** to a non-empty subset of the known
 *    channel values. The sketch left it a bare `text[]`, which would have let a
 *    typo'd channel name reach the dispatcher and be silently skipped.
 *  - **`content_hash` does not exist and no content is indexed.** Deliberate,
 *    and noted so a later reader does not add one: notification bodies are the
 *    one place a careless kind could put a sensitive string, and an index on
 *    content is an invitation to search it (SA-023, §4.6).
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- platform.notification -------------------------------------------------
  await withStandardColumns(
    db.schema
      .createTable('platform.notification')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side (ADR-0011)
      // The registered kind (`notify-kinds.ts`) whose Zod schema validated the
      // payload and whose template renders the email. Left `text` rather than a
      // CHECK-constrained enum on purpose: the registry is open-ended by design
      // — every consuming module adds kinds — and a CHECK would mean a migration
      // per notification type. The registry is the gate, and it is the *strict*
      // one, because it also binds the payload schema (§4.6).
      .addColumn('kind', 'text', (c) => c.notNull())
      // --- Recipient specification (PL-021): exactly one of three shapes. -----
      .addColumn('recipient_kind', 'text', (c) =>
        c.notNull().check(sql`recipient_kind IN ('role', 'policy', 'contextual')`),
      )
      .addColumn('recipient_role_id', 'uuid')
      // Optional scope for a 'role' spec — "line managers *of this team*"
      // rather than every line manager in the company. The distinction core
      // plan 09 learned the hard way about approver policies (its §4.5).
      .addColumn('recipient_team_id', 'uuid')
      // A `config:<namespace.key>` approver-policy reference (ADR-0016),
      // resolved through the same `resolveApprovalPolicy` the approval engine
      // authorises with — so who is *notified* and who may *act* cannot be
      // computed two ways and disagree (§5.1).
      .addColumn('recipient_policy_ref', 'text')
      // Derived from the subject at send time, never configured. PL-021 forbids
      // *configuration* naming an individual; "the requester of this thing" is
      // a property of the thing, so it names nobody in advance.
      .addColumn('recipient_contextual', 'text', (c) =>
        c.check(
          sql`recipient_contextual IN ('subject_person', 'requester', 'subject_line_manager')`,
        ),
      )
      // --- What it is about --------------------------------------------------
      .addColumn('subject_stream_type', 'text')
      .addColumn('subject_stream_id', 'uuid')
      // --- Content: PII-minimal (ADR-0019); never special-category (SA-023) ---
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('body', 'text', (c) => c.notNull())
      // App-relative deep link. Relative on purpose: an absolute URL in a row
      // is a redirect target an attacker would love, and both the web app and
      // the mobile app resolve the same path against their own base.
      .addColumn('action_url', 'text')
      .addColumn('payload', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('channels', sql`text[]`, (c) => c.notNull())
      .addColumn('status', 'text', (c) =>
        c
          .notNull()
          .defaultTo('pending')
          .check(sql`status IN ('pending', 'dispatched', 'expired')`),
      )
      .addColumn('dispatched_at', 'timestamptz')
      // The in-app visibility horizon (config default, §6). Past it the message
      // drops out of the inbox without being deleted — the delivery record of a
      // notification that was genuinely sent is not a thing to throw away.
      .addColumn('expires_at', 'timestamptz')
      // Idempotency for at-least-once effect delivery, and the reason a
      // redelivered reminder occurrence sends once (§4.5).
      .addColumn('dedupe_key', 'text'),
    { actorStamps: false },
  )
    // NULL = system-originated (a reminder firing, a workflow effect). The same
    // reason `platform.task.created_by` and `approval_request.requested_by` are
    // nullable: not every fact in this platform has a person behind it.
    .addColumn('created_by', 'uuid')
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint('notification_role_fkey', ['recipient_role_id'], 'platform.role', [
      'id',
    ])
    .addForeignKeyConstraint('notification_team_fkey', ['recipient_team_id'], 'platform.team', [
      'id',
    ])
    .addForeignKeyConstraint('notification_created_by_fkey', ['created_by'], 'platform.person', [
      'id',
    ])
    .addForeignKeyConstraint('notification_updated_by_fkey', ['updated_by'], 'platform.person', [
      'id',
    ])
    // Exactly one recipient shape, enforced by the database. Without this the
    // three columns are a suggestion and a caller can populate two.
    .addCheckConstraint(
      'notification_recipient_shape_chk',
      sql`
        (recipient_kind = 'role'       AND recipient_role_id    IS NOT NULL
                                       AND recipient_policy_ref IS NULL AND recipient_contextual IS NULL) OR
        (recipient_kind = 'policy'     AND recipient_policy_ref IS NOT NULL
                                       AND recipient_role_id    IS NULL AND recipient_contextual IS NULL) OR
        (recipient_kind = 'contextual' AND recipient_contextual IS NOT NULL
                                       AND recipient_role_id    IS NULL AND recipient_policy_ref IS NULL)
      `,
    )
    // A team scope only means anything alongside a role.
    .addCheckConstraint(
      'notification_team_scope_chk',
      sql`recipient_team_id IS NULL OR recipient_kind = 'role'`,
    )
    .addCheckConstraint(
      'notification_subject_shape_chk',
      sql`(subject_stream_type IS NULL) = (subject_stream_id IS NULL)`,
    )
    // A contextual recipient is derived *from the subject*, so there has to be
    // one. Without this a caller could ask to notify "the requester" of nothing.
    .addCheckConstraint(
      'notification_contextual_needs_subject_chk',
      sql`recipient_kind <> 'contextual' OR subject_stream_type IS NOT NULL`,
    )
    // At least one channel, and only channels the dispatcher knows. A typo'd
    // channel name would otherwise reach dispatch and be silently skipped.
    .addCheckConstraint(
      'notification_channels_chk',
      sql`cardinality(channels) > 0 AND channels <@ ARRAY['in_app', 'email', 'push']::text[]`,
    )
    .addCheckConstraint(
      'notification_dispatched_at_chk',
      sql`(status = 'dispatched') = (dispatched_at IS NOT NULL)`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.notification IS
      'One logical message: what to say, about what, and to whom in the abstract (PL-019). The recipient is a role, an approver policy or a contextual reference to the subject — never a person (PL-021). Resolved people appear only on notification_delivery rows, stamped at send time.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.notification.payload IS
      'Template parameters, validated by the kind''s registered Zod schema: ids and short non-sensitive display strings only. Special-category detail never appears here or in title/body on any channel (SA-023, ADR-0019).'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.notification.recipient_contextual IS
      'Derived from the subject stream at send time, not configured — which is why it does not breach PL-021: no person is named in advance, only a relationship to the subject.'
  `.execute(db);

  // Idempotency for at-least-once dispatch: a redelivered reminder occurrence
  // finds its own key taken and sends nothing (§4.5).
  await sql`
    CREATE UNIQUE INDEX notification_dedupe_key_uq
      ON platform.notification (dedupe_key) WHERE dedupe_key IS NOT NULL
  `.execute(db);

  // "What has been said about this record?" — the activity trail's read.
  await sql`
    CREATE INDEX notification_subject_idx
      ON platform.notification (subject_stream_type, subject_stream_id)
      WHERE deleted_at IS NULL
  `.execute(db);

  // The dispatcher's sweep, and the diagnostic "what is stuck?" query.
  await sql`
    CREATE INDEX notification_pending_idx
      ON platform.notification (created_at, id) WHERE status = 'pending' AND deleted_at IS NULL
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.notification');

  // --- platform.notification_delivery ---------------------------------------
  //
  // One row per channel attempt per resolved recipient. This table is the
  // answer to "did it actually reach anyone, and how do you know?" — which is
  // the question a notification service exists to answer and the one a log line
  // cannot (AC-D4).
  await withStandardColumns(
    db.schema
      .createTable('platform.notification_delivery')
      .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side
      .addColumn('notification_id', 'uuid', (c) => c.notNull())
      // The RESOLVED recipient, stamped at send time (PL-021). This is the only
      // place in the notification model a person id appears, and it is a record
      // of what happened rather than a configuration of what will.
      .addColumn('person_id', 'uuid', (c) => c.notNull())
      // *Why* this person — which half of the spec matched. Without it, a role
      // that has since changed makes a year-old delivery list unexplainable.
      .addColumn('resolved_via', 'text', (c) =>
        c.notNull().check(sql`resolved_via IN ('role', 'policy', 'contextual')`),
      )
      .addColumn('channel', 'text', (c) =>
        c.notNull().check(sql`channel IN ('in_app', 'email', 'push')`),
      )
      .addColumn('status', 'text', (c) =>
        c
          .notNull()
          .defaultTo('pending')
          .check(sql`status IN ('pending', 'sent', 'failed', 'dead', 'suppressed')`),
      )
      .addColumn('attempt_count', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('attempted_at', 'timestamptz')
      .addColumn('last_error', 'text')
      .addColumn('provider_ref', 'text')
      // In-app only: unread ⇔ read_at IS NULL. Deliberately *not* journalled —
      // reading a notification is UI telemetry, not a business fact (§4.4).
      .addColumn('read_at', 'timestamptz'),
    { softDelete: false, actorStamps: false },
  )
    // NULL for every machine-created row, which is nearly all of them; set only
    // where a person acted (a mark-read).
    .addColumn('created_by', 'uuid')
    .addColumn('updated_by', 'uuid')
    .addForeignKeyConstraint(
      'notification_delivery_notification_fkey',
      ['notification_id'],
      'platform.notification',
      ['id'],
    )
    .addForeignKeyConstraint(
      'notification_delivery_person_fkey',
      ['person_id'],
      'platform.person',
      ['id'],
    )
    .addForeignKeyConstraint(
      'notification_delivery_updated_by_fkey',
      ['updated_by'],
      'platform.person',
      ['id'],
    )
    // The idempotency backstop for at-least-once dispatch (§5.6).
    .addUniqueConstraint('delivery_once_per_person_channel', [
      'notification_id',
      'person_id',
      'channel',
    ])
    // Only an in-app delivery can be read; an email has no read state we can
    // honestly claim to know.
    .addCheckConstraint(
      'delivery_read_at_chk',
      sql`read_at IS NULL OR (channel = 'in_app' AND status = 'sent')`,
    )
    // A row that has been attempted says when, and one that has not says
    // nothing — neither half can drift from the other.
    .addCheckConstraint(
      'delivery_attempted_at_chk',
      sql`(attempt_count = 0) = (attempted_at IS NULL)`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE platform.notification_delivery IS
      'One row per channel attempt per resolved recipient (PL-019). Failures are recorded here — last_error, attempt_count, terminal dead — never lost in logs alone (AC-D4). A channel disabled in configuration produces a suppressed row rather than nothing at all.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.notification_delivery.person_id IS
      'The resolved recipient, stamped at send time. The only person reference in the notification model: a record of who was reached, never a configuration of who will be (PL-021).'
  `.execute(db);

  // "My inbox", in keyset order. The partial predicate keeps it to the channel
  // that has an inbox at all.
  await sql`
    CREATE INDEX delivery_inbox_idx
      ON platform.notification_delivery (person_id, created_at DESC, id DESC)
      WHERE channel = 'in_app'
  `.execute(db);

  // The unread badge, which every authenticated page polls — so it is a partial
  // index over exactly the rows it counts rather than a filter over the inbox.
  await sql`
    CREATE INDEX delivery_unread_idx
      ON platform.notification_delivery (person_id)
      WHERE channel = 'in_app' AND read_at IS NULL
  `.execute(db);

  // The retry sweep's claim.
  await sql`
    CREATE INDEX delivery_retry_idx
      ON platform.notification_delivery (status) WHERE status IN ('pending', 'failed')
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.notification_delivery');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.notification_delivery').ifExists().execute();
  await db.schema.dropTable('platform.notification').ifExists().execute();
}
