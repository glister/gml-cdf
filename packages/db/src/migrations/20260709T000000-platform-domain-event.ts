import { Kysely, sql } from 'kysely';

/**
 * Core plan 02 (ADR-0010): the append-only `platform.domain_event` journal —
 * one immutable row appended in the same transaction as every business fact —
 * plus `platform.event_consumption`, the at-least-once dedupe ledger every topic
 * subscriber writes to.
 *
 * Deliberate deviations from the ADR-0011 standard-column conventions, all per
 * ADR-0010 and documented here:
 *
 *  - **No standard columns.** The journal carries its own bespoke timestamps
 *    (`occurred_at` business time, `recorded_at` insert time, `published_at`
 *    relay time) and actor columns (`actor_person_id`, `on_behalf_of`) rather
 *    than `created_at`/`updated_by`/etc. `recorded_at` plays the `created_at`
 *    role. It is append-only, so it has no `updated_at`/`deleted_at`.
 *  - **No foreign keys.** `actor_person_id`/`on_behalf_of`/`stream_id`/
 *    `event_id` reference records (`platform.person`, arbitrary subject rows)
 *    that either do not exist yet (person lands in plan 03) or are hard-deleted
 *    by erasure (plan 16). The journal must never block or cascade from a
 *    state-row operation, so referential validity is an application concern
 *    enforced by `appendEvent`. (ADR-0011 permits documented FK deviations.)
 *  - **A specialised append-only guard.** Unlike the generic
 *    `platform.append_only_guard` (core plan 01), this table has two legal
 *    mutations — the outbox `published_at` stamp and erasure-role payload
 *    redaction (ADR-0019) — so it gets its own `platform.domain_event_guard`.
 *    All other append-only tables use the generic guard.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- platform.domain_event ---------------------------------------------
  await db.schema
    .createTable('platform.domain_event')
    .addColumn('id', 'uuid', (c) => c.primaryKey()) // UUIDv7, app-side (ADR-0011)
    .addColumn('kind', 'text', (c) =>
      c
        .notNull()
        .defaultTo('domain')
        .check(sql`kind IN ('domain', 'admin', 'security')`),
    )
    .addColumn('stream_type', 'text', (c) => c.notNull()) // e.g. 'platform.person'
    .addColumn('stream_id', 'uuid', (c) => c.notNull()) // PK of the subject record
    .addColumn('event_type', 'text', (c) => c.notNull()) // namespaced past-tense fact (ADR-0021)
    .addColumn('payload', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`)) // PII-minimal (ADR-0019)
    .addColumn('schema_version', 'integer', (c) => c.notNull()) // per event_type, from the registry
    .addColumn('actor_person_id', 'uuid') // NULL for system/unauthenticated actions
    .addColumn('on_behalf_of', 'uuid') // HR acting for an employee (ADR-0011)
    .addColumn('correlation_id', 'uuid', (c) => c.notNull()) // ties a user action to its cascade
    .addColumn('causation_id', 'uuid') // id of the event/message that caused this one
    .addColumn('occurred_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`)) // business time
    .addColumn('recorded_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`)) // insert time; relay/ETL order
    .addColumn('published_at', 'timestamptz') // NULL until relayed (outbox semantics)
    .execute();

  await sql`
    COMMENT ON TABLE platform.domain_event IS
      'Append-only domain-event journal + outbox (ADR-0010). Immutable except the published_at stamp and erasure-role payload redaction. No FKs by design (ADR-0011 deviation).'
  `.execute(db);

  // Indexes: one per known consumer, no speculative extras. The person-timeline
  // indexes (actor/subject legs) and the kind-partial log indexes are OWNED BY
  // plan 13, which amends this table (adds subject_person_id) in its own
  // migration — they are deliberately NOT created here.
  await db.schema // activity trail per record (plan 13)
    .createIndex('domain_event_stream_idx')
    .on('platform.domain_event')
    .columns(['stream_type', 'stream_id', 'recorded_at', 'id'])
    .execute();
  await sql`
    CREATE INDEX domain_event_unpublished_idx
      ON platform.domain_event (recorded_at, id) WHERE published_at IS NULL
  `.execute(db); // relay scan; tiny partial index
  await db.schema // ETL watermark paging (plan 15, ADR-0018)
    .createIndex('domain_event_recorded_at_idx')
    .on('platform.domain_event')
    .columns(['recorded_at', 'id'])
    .execute();

  // Append-only at the database level (ADR-0011). Phase 1 runs a single DB role
  // that is a superuser (plan 01 §12.2 Q1), so the guard trigger is the binding
  // enforcement and the REVOKE is defence-in-depth for the future least-privilege
  // role split — at which point the runtime role gets GRANT UPDATE (published_at)
  // only. A statement-level BEFORE TRUNCATE trigger (row triggers never see
  // TRUNCATE) reuses the generic guard, which raises for every non-erasure role.
  await sql`REVOKE UPDATE, DELETE, TRUNCATE ON platform.domain_event FROM PUBLIC`.execute(db);

  await sql`
    CREATE FUNCTION platform.domain_event_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- DELETE is never legal, for any role (erasure redacts payloads, it does
      -- not delete journal rows — ADR-0019).
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'platform.domain_event is append-only (ADR-0011): DELETE blocked';
      END IF;

      -- Exception 1: erasure-role payload redaction (ADR-0019). The dedicated
      -- cdf_erasure role (plan 16) may change ONLY the payload column; every
      -- other column must be identical. Checked defensively so this function is
      -- valid before that role exists (plan 16 builds the erasure job later).
      IF to_regrole('cdf_erasure') IS NOT NULL
         AND pg_has_role(current_user, 'cdf_erasure', 'MEMBER')
         AND (to_jsonb(OLD) - 'payload') = (to_jsonb(NEW) - 'payload') THEN
        RETURN NEW;
      END IF;

      -- Exception 2: the outbox stamp — published_at NULL -> value, and nothing
      -- else changes. This is the row's single lifecycle transition (§4.3).
      IF OLD.published_at IS NULL
         AND NEW.published_at IS NOT NULL
         AND (to_jsonb(OLD) - 'published_at') = (to_jsonb(NEW) - 'published_at') THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'platform.domain_event is append-only (ADR-0011): only the outbox stamp and erasure redaction are permitted';
    END;
    $$;
  `.execute(db);

  await sql`
    CREATE TRIGGER domain_event_guard BEFORE UPDATE OR DELETE
      ON platform.domain_event FOR EACH ROW
      EXECUTE FUNCTION platform.domain_event_guard()
  `.execute(db);

  // TRUNCATE cannot be caught by a row-level trigger; block it statement-level.
  await sql`
    CREATE TRIGGER domain_event_guard_truncate BEFORE TRUNCATE
      ON platform.domain_event FOR EACH STATEMENT
      EXECUTE FUNCTION platform.append_only_guard()
  `.execute(db);

  // --- platform.event_consumption ----------------------------------------
  // At-least-once dedupe ledger for topic subscribers: `INSERT … ON CONFLICT DO
  // NOTHING` inside the consumer's transaction; zero rows inserted ⇒ duplicate
  // delivery ⇒ complete the message without side effects (§5.2). No FK to
  // domain_event.id for the same reason the journal itself carries none.
  await db.schema
    .createTable('platform.event_consumption')
    .addColumn('consumer', 'text', (c) => c.notNull()) // subscription/handler name
    .addColumn('event_id', 'uuid', (c) => c.notNull()) // platform.domain_event.id
    .addColumn('consumed_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('event_consumption_pkey', ['consumer', 'event_id'])
    .execute();

  await sql`
    COMMENT ON TABLE platform.event_consumption IS
      'At-least-once idempotency ledger for domain-event subscribers (core plan 02 §5.2).'
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.event_consumption').ifExists().execute();
  // Dropping the table removes its triggers; drop the specialised guard function
  // afterwards. The generic append_only_guard (plan 01) is left in place.
  await db.schema.dropTable('platform.domain_event').ifExists().execute();
  await sql`DROP FUNCTION IF EXISTS platform.domain_event_guard()`.execute(db);
}
