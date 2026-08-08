import { Kysely, sql } from 'kysely';
import { attachUpdatedAtTrigger, withStandardColumns } from '../migration-helpers.js';

/**
 * Core plan 12 §4.2 (PL-024): `platform.calendar_sync_state` — the Outlook
 * round-trip record.
 *
 * The calendar itself is a **read model** with no table (implementation notes
 * §2): the feed is a SQL union of per-module source fragments, so there is
 * nothing durable to hang a Graph event id on. The sync rail needs one, because
 * amending or cancelling an item later means PATCHing or DELETEing the *same*
 * Outlook event — Graph's id is the only handle, and it exists nowhere in our
 * state until we store it.
 *
 * History class (ADR-0012): **operational state** → a mutable row with
 * `updated_at`. The *facts* (created, amended, cancelled, failed) are journal
 * events appended in the same transaction as every status change (ADR-0010), so
 * the history survives without making this table append-only. The row answers
 * only "what is true right now, and which Graph event is it".
 *
 * Two columns carry the idempotency the rail depends on, and both matter because
 * Service Bus delivery is at-least-once (ADR-0005):
 *
 *  - **`id` doubles as the Graph `transactionId`.** It is generated before the
 *    create call, so a crash between Graph accepting the POST and this row being
 *    updated cannot produce a second Outlook event on redelivery — Graph itself
 *    dedupes on the id it has already seen.
 *  - **`last_synced_hash`** is the sha256 of the projected payload. A redelivered
 *    amend whose projection is unchanged is a no-op rather than a pointless
 *    PATCH, which is what keeps a chatty source from burning Graph throttle.
 *
 * `UNIQUE (source_key, source_ref)` is the structural half of the same
 * guarantee: a calendar item has at most one sync record, whatever the queue
 * does. `(source_key, source_ref)` is the read model's permanent identity
 * (§4.1.1) — the pair, not the ref alone, because two modules may legitimately
 * key rows the same way.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await withStandardColumns(
    db.schema
      .createTable('platform.calendar_sync_state')
      // UUIDv7, app-side (ADR-0011). Also the Graph transactionId — see above.
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      // The registered calendar source, e.g. 'hr.leave'. Not FK-constrained:
      // the source registry is code (§4.1.2), deliberately not database rows.
      .addColumn('source_key', 'text', (c) => c.notNull())
      // The source's own permanent id for the item (its row PK, as text).
      .addColumn('source_ref', 'text', (c) => c.notNull())
      .addColumn('person_id', 'uuid', (c) =>
        c.notNull().references('platform.person.id').onDelete('no action'),
      )
      // NULL until the create succeeds; the handle for every later amend/cancel.
      .addColumn('graph_event_id', 'text')
      // sha256 of the last-pushed projection (§5.2) — the amend no-op guard.
      .addColumn('last_synced_hash', 'text')
      .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
      .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
      // Diagnostic only. Graph error text, truncated by the handler — never a
      // request or response body, which could carry the subject line (ADR-0019).
      .addColumn('last_error', 'text'),
  )
    .addCheckConstraint(
      'calendar_sync_state_status_chk',
      sql`status IN ('pending','synced','amend_pending','cancel_pending','cancelled','failed')`,
    )
    .addCheckConstraint('calendar_sync_state_attempts_chk', sql`attempts >= 0`)
    .addUniqueConstraint('calendar_sync_state_item_uq', ['source_key', 'source_ref'])
    .execute();

  await sql`
    COMMENT ON TABLE platform.calendar_sync_state IS
      'Outlook sync round-trip state for calendar items (PL-024, core plan 12 §4.2). Operational state, not history: every status change appends its journal event in the same transaction. id doubles as the Graph transactionId so at-least-once redelivery cannot create duplicate Outlook events.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN platform.calendar_sync_state.last_synced_hash IS
      'sha256 of the canonical JSON of the last projection pushed to Graph. A redelivered amend with an equal hash is a no-op (§5.2 step 4).'
  `.execute(db);

  // The person's synced items — read by plan 16's erasure sweep, which must
  // cancel any live Outlook event before redacting the person (§12.3).
  await sql`
    CREATE INDEX calendar_sync_state_person_idx
      ON platform.calendar_sync_state (person_id)
  `.execute(db);

  // The worker's work queue: only the states that still owe Graph a call.
  await sql`
    CREATE INDEX calendar_sync_state_status_idx
      ON platform.calendar_sync_state (status)
      WHERE status IN ('pending','amend_pending','cancel_pending','failed')
  `.execute(db);

  await attachUpdatedAtTrigger(db, 'platform.calendar_sync_state');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('platform.calendar_sync_state').ifExists().execute();
}
