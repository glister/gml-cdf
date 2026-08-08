import { sql, type Kysely } from 'kysely';
import type { DB } from '@repo/db';
import {
  platformDemoCalendarItemApproved,
  platformDemoCalendarItemCancelled,
  platformDemoCalendarItemRescheduled,
} from '@repo/domain';
import {
  canonicalFragment,
  registerCalendarSource,
  type CalendarWindow,
  type SyncableItem,
} from '../registry.js';

/**
 * The pilot source (core plan 12 §5.1/§9.3, PL-024) — the thing that makes the
 * Outlook rail demonstrable with no HR module in existence.
 *
 * ## It has no table, on purpose
 *
 * The three `platform.demo.calendar_item_*` events **are** this source's state.
 * `load()` folds the newest event for a ref back into a syncable item, and the
 * fragment does the same thing set-wise for the feed. A `demo_item` table would
 * have been a migration, a codegen override, an erasure obligation for plan 16
 * and a row nobody outside a demonstration ever writes — for state the journal
 * already holds, correctly, in order, with an actor on every row.
 *
 * It also makes the pilot prove something real. The rail's whole contract is
 * "fold a stream of create/cancel facts into an external calendar", and this
 * source folds exactly that stream — rather than reading a table whose current
 * row would paper over any ordering bug in the rail.
 *
 * ## Kind
 *
 * `hr_event`, not `leave`. A demo item is "there is something in the calendar",
 * which is precisely what the generic PL-023a kind means; calling it leave would
 * put a fabricated absence in the same colour and the same filter as real ones.
 */

export const DEMO_SOURCE_KEY = 'platform.demo_item';

/** The label every demo item renders as, on the calendar and in Outlook. */
const DEMO_LABEL = 'Demo item';

/** `<person>:<ref>` — the ref alone is not unique across administrators. */
export function demoSourceRef(personId: string, ref: string): string {
  return `${personId}:${ref}`;
}

/** Split a demo `source_ref` back into its parts. */
export function parseDemoSourceRef(sourceRef: string): { personId: string; ref: string } | null {
  const split = sourceRef.indexOf(':');
  if (split <= 0) return null;
  return { personId: sourceRef.slice(0, split), ref: sourceRef.slice(split + 1) };
}

const APPROVED = platformDemoCalendarItemApproved.type;
const RESCHEDULED = platformDemoCalendarItemRescheduled.type;
const CANCELLED = platformDemoCalendarItemCancelled.type;

/**
 * The newest event per `(stream_id, ref)`, as a derived table.
 *
 * `recorded_at DESC, id DESC` rather than `occurred_at`: two demo actions in the
 * same millisecond are entirely possible from a test, and UUIDv7 ids are
 * monotonic, so the id is the tiebreak that makes "newest" total.
 */
const latestPerRef = sql`(
  SELECT DISTINCT ON (e.stream_id, e.payload->>'ref')
    e.stream_id                        AS person_id,
    e.payload->>'ref'                  AS ref,
    (e.payload->>'startsOn')::date     AS starts_on,
    (e.payload->>'endsOn')::date       AS ends_on,
    e.event_type                       AS event_type
  FROM platform.domain_event e
  WHERE e.event_type IN (${sql.lit(APPROVED)}, ${sql.lit(RESCHEDULED)}, ${sql.lit(CANCELLED)})
  ORDER BY e.stream_id, e.payload->>'ref', e.recorded_at DESC, e.id DESC
)`;

export const demoItemSource = registerCalendarSource({
  key: DEMO_SOURCE_KEY,
  kinds: ['hr_event'],
  visibilityClass: 'normal',
  fragment: (window: CalendarWindow) =>
    canonicalFragment(
      { key: DEMO_SOURCE_KEY, visibilityClass: 'normal' },
      {
        sourceRef: sql`d.person_id::text || ':' || d.ref`,
        personId: sql`d.person_id`,
        startsOn: sql`d.starts_on`,
        endsOn: sql`d.ends_on`,
        kind: sql`'hr_event'`,
        label: sql.lit(DEMO_LABEL),
        // Only approved items exist here: the demo procedure has no "request"
        // action, because the rail's rule is that nothing unapproved is pushed.
        status: sql`'approved'`,
      },
      sql`FROM ${latestPerRef} d
          WHERE d.event_type <> ${sql.lit(CANCELLED)}
            AND d.starts_on <= ${window.to}::date
            AND d.ends_on   >= ${window.from}::date`,
    ),
  outlookSync: {
    onApproved: APPROVED,
    onAmended: RESCHEDULED,
    onCancelled: CANCELLED,
    load: loadDemoItem,
    sourceRefFor: ({ streamId, payload }) => {
      const ref = (payload as { ref?: unknown } | null)?.ref;
      return typeof ref === 'string' ? demoSourceRef(streamId, ref) : null;
    },
  },
});

/**
 * Rebuild one demo item from its stream, or `null` if it was cancelled.
 *
 * Called by the worker **at execution time**, which is the guard that matters:
 * a redelivered `approved` message that arrives after the item was cancelled
 * finds `null` here and creates nothing (§5.2 step 6).
 */
export async function loadDemoItem(
  db: Kysely<DB>,
  sourceRef: string,
): Promise<SyncableItem | null> {
  const parsed = parseDemoSourceRef(sourceRef);
  if (!parsed) return null;

  const result = await sql<{
    starts_on: string | null;
    ends_on: string | null;
    event_type: string;
  }>`
    SELECT
      to_char(d.starts_on, 'YYYY-MM-DD') AS starts_on,
      to_char(d.ends_on,   'YYYY-MM-DD') AS ends_on,
      d.event_type
    FROM ${latestPerRef} d
    WHERE d.person_id = ${parsed.personId}::uuid AND d.ref = ${parsed.ref}
  `.execute(db);

  const row = result.rows[0];
  if (!row || row.event_type === CANCELLED) return null;
  if (!row.starts_on || !row.ends_on) return null;

  return {
    sourceKey: DEMO_SOURCE_KEY,
    sourceRef,
    personId: parsed.personId,
    label: DEMO_LABEL,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    dayPart: null,
    kind: 'hr_event',
  };
}
