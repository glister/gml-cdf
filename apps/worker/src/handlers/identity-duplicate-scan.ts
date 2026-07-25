import { type SqlBool, sql } from 'kysely';
import { appendEvent, newUuidV7 } from '@repo/db';
import { type DuplicateMatchReason, matchDuplicate } from '@repo/domain';
import type { HandlerContext } from '../types.js';

/** The `effects`-queue message subject that triggers this sweep. */
export const DUPLICATE_SCAN_SUBJECT = 'platform.identity.duplicate-scan';

/**
 * Nightly duplicate scan (core plan 03 §5.2, PL-037) — the safety net for
 * attributes captured after the pre-creation check. Find strong duplicate pairs
 * (same rule as the matcher / the review screen), skip any pair already flagged
 * or dismissed, and journal `platform.person.duplicate_flagged` for each new one.
 * Advisory only: nothing is blocked and nothing auto-merges (PL-041). Canonical
 * pair order (the lower id is the event stream) matches the review anti-join.
 */
export async function runDuplicateScan({ db, logger }: HandlerContext): Promise<void> {
  const correlationId = newUuidV7();
  const pairs = await db
    .selectFrom('platform.person as a')
    .innerJoin('platform.person as b', (join) => join.onRef('a.id', '<', 'b.id'))
    .select([
      'a.id as a_id',
      'a.given_name as a_given_name',
      'a.family_name as a_family_name',
      'a.date_of_birth as a_date_of_birth',
      'a.agency_worker_reference as a_agency_worker_reference',
      'b.id as b_id',
      'b.given_name as b_given_name',
      'b.family_name as b_family_name',
      'b.date_of_birth as b_date_of_birth',
      'b.agency_worker_reference as b_agency_worker_reference',
    ])
    .where('a.deleted_at', 'is', null)
    .where('b.deleted_at', 'is', null)
    .where('a.status', '<>', 'superseded')
    .where('b.status', '<>', 'superseded')
    .where(
      sql<SqlBool>`(
        (a.family_name IS NOT NULL AND a.given_name IS NOT NULL AND a.date_of_birth IS NOT NULL
           AND lower(a.family_name) = lower(b.family_name)
           AND lower(a.given_name) = lower(b.given_name)
           AND a.date_of_birth = b.date_of_birth)
        OR (a.agency_worker_reference IS NOT NULL
           AND lower(a.agency_worker_reference) = lower(b.agency_worker_reference))
      )`,
    )
    // Skip pairs already flagged or dismissed (canonical: min id is the stream).
    .where(
      sql<SqlBool>`NOT EXISTS (
        SELECT 1 FROM platform.domain_event d
        WHERE d.event_type IN ('platform.person.duplicate_flagged', 'platform.person.duplicate_dismissed')
          AND d.stream_id = a.id AND d.payload->>'otherPersonId' = b.id::text
      )`,
    )
    .execute();

  let flagged = 0;
  for (const pair of pairs) {
    const { reasons } = matchDuplicate(
      {
        givenName: pair.a_given_name,
        familyName: pair.a_family_name,
        dateOfBirth: pair.a_date_of_birth,
        agencyWorkerReference: pair.a_agency_worker_reference,
      },
      {
        givenName: pair.b_given_name,
        familyName: pair.b_family_name,
        dateOfBirth: pair.b_date_of_birth,
        agencyWorkerReference: pair.b_agency_worker_reference,
      },
    );
    if (reasons.length === 0) continue; // defensive; the SQL already matched
    await db.transaction().execute((trx) =>
      appendEvent(trx, {
        kind: 'security',
        streamType: 'platform.person',
        streamId: pair.a_id,
        eventType: 'platform.person.duplicate_flagged',
        payload: { otherPersonId: pair.b_id, reasons: reasons as DuplicateMatchReason[] },
        actorPersonId: null,
        correlationId,
      }),
    );
    flagged += 1;
  }
  logger.info('identity.duplicate-scan', { candidates: pairs.length, flagged });
}
