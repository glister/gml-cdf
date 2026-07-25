import { sql } from 'kysely';
import { appendEvent, newUuidV7 } from '@repo/db';
import { disableSignIn } from '@repo/identity';
import type { HandlerContext } from '../types.js';

/** The `effects`-queue message subject that triggers this sweep. */
export const ACCESS_EXPIRY_SWEEP_SUBJECT = 'platform.identity.access-expiry-sweep';

/**
 * Access-expiry sweep (core plan 03 §5.2, PL-042, ON AC-9). Disable sign-in and
 * mark inactive every external whose `access_valid_until` has passed. Each person
 * is handled in its own transaction: guard on `status='active'` (so a re-run is a
 * no-op — idempotent), ban + revoke sessions via the adapter, flip to `inactive`,
 * and journal `platform.person.access_expired` (plan 04 revokes role grants on
 * that event). One correlation id ties the whole sweep together.
 */
export async function runAccessExpirySweep({ db, logger }: HandlerContext): Promise<void> {
  const correlationId = newUuidV7();
  const due = await db
    .selectFrom('platform.person')
    .select('id')
    .where('status', '=', 'active')
    .where('access_valid_until', 'is not', null)
    .where('access_valid_until', '<', sql<Date>`now()`)
    .execute();

  let expired = 0;
  for (const person of due) {
    await db.transaction().execute(async (trx) => {
      // Re-check status inside the transaction so a concurrent change (or a
      // redelivered sweep) never double-journals.
      const res = await trx
        .updateTable('platform.person')
        .set({ status: 'inactive' })
        .where('id', '=', person.id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if ((res.numUpdatedRows ?? 0n) === 0n) return;

      await disableSignIn(trx, person.id, 'access valid-until date passed');
      await appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: person.id,
        eventType: 'platform.person.access_expired',
        payload: {},
        actorPersonId: null,
        correlationId,
      });
      expired += 1;
    });
  }
  logger.info('identity.access-expiry-sweep', { considered: due.length, expired });
}
