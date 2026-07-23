import type { Kysely, Transaction } from 'kysely';
import { recordConsumptionOnce, type DB } from '@repo/db';

/**
 * The idempotent-consumer contract every subscriber uses (core plan 02 §5.2).
 * In one transaction: record that `consumer` has handled `eventId`; if this is a
 * duplicate delivery, stop without side effects; otherwise run `fn` (side
 * effects + any follow-on `appendEvent` with `causationId = eventId`) on the
 * SAME transaction, so the dedupe row and the effects commit together.
 *
 * Returns `true` when the work ran, `false` on a duplicate. Handlers should
 * complete the message either way — the point of the ledger is that redelivery
 * is safe.
 *
 * `record` is injectable for tests; production uses `recordConsumptionOnce`.
 */
export async function consumeOnce(
  db: Kysely<DB>,
  consumer: string,
  eventId: string,
  fn: (trx: Transaction<DB>) => Promise<void>,
  record: (
    trx: Transaction<DB>,
    consumer: string,
    eventId: string,
  ) => Promise<boolean> = recordConsumptionOnce,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const first = await record(trx, consumer, eventId);
    if (!first) return false;
    await fn(trx);
    return true;
  });
}
