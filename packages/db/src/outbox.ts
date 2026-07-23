import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { DB, PlatformDomainEvent } from './types.js';

type DomainEventRecord = Selectable<PlatformDomainEvent>;

/**
 * The outbox SQL primitives for the domain-event relay (core plan 02 §5.2).
 *
 * These live in `@repo/db` — not `apps/worker` — deliberately: they are journal
 * SQL, so the repo keeps SQL in the db layer where it is exercised against real
 * Postgres (ADR-0004), and the worker's relay/consumer tests stay pure
 * orchestration with no database (which also avoids the worker and db test
 * suites racing on the shared `cdf_test`). The worker composes these with the
 * Service Bus sender, the envelope mapping, and the poll loop.
 */

/**
 * Claim a batch of unpublished journal rows, hand them to `publish`, and stamp
 * `published_at` — all in ONE transaction. Rows are locked
 * `FOR UPDATE SKIP LOCKED`, so multiple worker replicas relay disjoint batches.
 *
 * Publish-then-stamp inside the transaction gives **at-least-once**: if `publish`
 * throws (or the process crashes) before the stamp commits, the whole
 * transaction rolls back and the rows relay again on the next tick — consumers
 * dedupe. Returns the number of rows published (0 when the outbox is empty).
 */
export async function relayOutboxBatch(
  db: Kysely<DB>,
  limit: number,
  publish: (events: DomainEventRecord[]) => Promise<void>,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('platform.domain_event')
      .selectAll()
      .where('published_at', 'is', null)
      .orderBy('recorded_at')
      .orderBy('id')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();

    if (rows.length === 0) return 0;

    await publish(rows);

    // Stamp only after a successful publish. Each row transitions
    // published_at NULL -> now(), the sole mutation the domain_event guard
    // permits (§4.3).
    await trx
      .updateTable('platform.domain_event')
      .set({ published_at: sql`now()` })
      .where(
        'id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();

    return rows.length;
  });
}

/**
 * Record that `consumer` has handled `eventId`, idempotently (§5.2). Runs on the
 * caller's transaction so the dedupe row and the handler's side effects commit
 * together. Returns `true` the first time (caller performs side effects),
 * `false` on a duplicate delivery (caller completes the message and stops).
 */
export async function recordConsumptionOnce(
  trx: Transaction<DB>,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const res = await trx
    .insertInto('platform.event_consumption')
    .values({ consumer, event_id: eventId })
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  return (res.numInsertedOrUpdatedRows ?? 0n) > 0n;
}
