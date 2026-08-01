import { sql } from 'kysely';
import { appendEvent, newUuidV7, revokeAllGrantsForPerson } from '@repo/db';
import { disableSignIn } from '@repo/identity';
import type { HandlerContext } from '../types.js';

/** The `effects`-queue message subject that triggers this sweep. */
export const ACCESS_EXPIRY_SWEEP_SUBJECT = 'platform.identity.access-expiry-sweep';

/**
 * Access-expiry sweep (core plan 03 §5.2, PL-042, ON AC-9). Disable sign-in and
 * mark inactive every external whose `access_valid_until` has passed. Each person
 * is handled in its own transaction: guard on `status='active'` (so a re-run is a
 * no-op — idempotent), ban + revoke sessions via the adapter, flip to `inactive`,
 * **revoke every live role grant** (core plan 04, the de-roling half of PL-042),
 * and journal `platform.person.access_expired`. One correlation id ties the
 * whole sweep together.
 *
 * De-roling happens by direct call, not by subscribing to the event we emit
 * (core plan 04 §5.2): identity and authorisation are both the platform module,
 * so an event round-trip would buy nothing and would lose atomicity — the
 * disable and the de-role must commit together, or an expired external could
 * keep authorising until a consumer caught up.
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
  let grantsRevoked = 0;
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
      // De-role in the same transaction — each revocation journals its own
      // `platform.role.revoked` with reason 'expired', so the trail says exactly
      // what access was removed (PL-042, AC-D3). System actor: NULL.
      const revoked = await revokeAllGrantsForPerson(trx, {
        personId: person.id,
        actorPersonId: null,
        reason: 'expired',
        correlationId,
      });
      grantsRevoked += revoked.length;
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
  logger.info('identity.access-expiry-sweep', {
    considered: due.length,
    expired,
    grantsRevoked,
  });
}
