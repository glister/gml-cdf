import { addCalendarDays, parseCalendarDate, ZonedTimeError } from '../lib/zoned-time.js';

/**
 * The Outlook projection (core plan 12 §5.2 step 3, PL-024) — turning a
 * syncable calendar item into the Graph event body we push, and into the
 * canonical string whose digest decides whether pushing it again is worth
 * doing.
 *
 * Pure by construction (ADR-0009): no clock, no I/O, and the organisation's
 * timezone is a **parameter**, not a constant read from anywhere. §12.1 assumes
 * Europe/London for a single-site UK client; passing it in is what makes that an
 * assumption the caller states rather than one this file bakes in.
 *
 * ## Why the digest is not here
 *
 * §9.2 asked for `syncHash(payload)` in this package. It cannot be: a SHA-256
 * needs `node:crypto`, and `@repo/domain` bans `node:*` outright (lint-enforced).
 * This is the same split core plan 11 made for the document hash, for the same
 * reason and with the same shape — **the canonicalisation lives here**, because
 * "which bytes get hashed" is the part that decides whether the guard works,
 * and it is testable with no crypto implementation. The one-line digest lives
 * beside its caller in `@repo/trpc/lib/calendar/sync-hash.ts`.
 */

/** The half of a day an item covers, when it does not cover all of it. */
export type CalendarDayPart = 'am' | 'pm';

/** What the Outlook rail needs to know about an item to push it (§5.2). */
export interface OutlookProjectionInput {
  /** Display text. For a restricted source this is the injected constant. */
  label: string;
  /** Inclusive `YYYY-MM-DD`. */
  startsOn: string;
  /** Inclusive `YYYY-MM-DD`; must not precede `startsOn`. */
  endsOn: string;
  /** `null` for whole days. */
  dayPart: CalendarDayPart | null;
  /** The canonical event shape's `kind` — becomes the Outlook category. */
  kind: string;
}

/** Graph's date/time-with-zone shape. */
export interface GraphDateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}

/**
 * The Graph event body, as pushed. Deliberately a small, fixed set of fields:
 * anything we do not send is a field an employee can still edit in their own
 * calendar without the next amend fighting them for it.
 */
export interface OutlookEventProjection {
  subject: string;
  isAllDay: true;
  start: GraphDateTimeTimeZone;
  /** **Exclusive** — Graph's all-day contract. See {@link projectOutlookEvent}. */
  end: GraphDateTimeTimeZone;
  /** Free/busy status. `oof` = out of office. */
  showAs: 'oof';
  categories: string[];
}

/** Thrown when an item cannot be projected — a malformed or inverted range. */
export class OutlookProjectionError extends ZonedTimeError {
  constructor(message: string) {
    super(message);
    this.name = 'OutlookProjectionError';
  }
}

/** How a half-day is worded in the subject line. */
const DAY_PART_SUFFIX: Record<CalendarDayPart, string> = {
  am: 'morning',
  pm: 'afternoon',
};

/** Render a wall-clock date back to `YYYY-MM-DD`. */
function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Project a syncable item into the Graph event body.
 *
 * **`end` is exclusive, and getting that wrong is a one-day error nobody
 * notices until somebody's last day of leave is missing.** Our canonical shape
 * (§4.1.1) has `ends_on` **inclusive** — the last day the person is away —
 * because that is how people talk about leave and how every source table stores
 * it. Graph's all-day events are half-open: an event that covers 10–14 August
 * has `end` of the 15th. The conversion is one calendar-day addition, done in
 * the calendar (`addCalendarDays`) rather than by adding 86 400 000 ms, so it
 * cannot drift across a clock change.
 *
 * **Half-days are all-day events with a labelled subject.** Outlook has no
 * half-day concept. Producing a timed event instead would mean inventing
 * working hours CDF has not configured, and rounding a half day up to a whole
 * one silently over-blocks the person's calendar. Naming it in the subject is
 * the honest option available today; when half-day leave actually lands
 * (`day_part` is future scope in §4.1.1), the working-hours configuration it
 * needs arrives with it and this can become a timed projection.
 */
export function projectOutlookEvent(
  item: OutlookProjectionInput,
  timeZone: string,
): OutlookEventProjection {
  if (timeZone.length === 0) {
    throw new OutlookProjectionError('a timezone is required to project an all-day event');
  }

  const start = parseCalendarDate(item.startsOn, 'startsOn');
  const endInclusive = parseCalendarDate(item.endsOn, 'endsOn');

  if (item.endsOn < item.startsOn) {
    throw new OutlookProjectionError(
      `endsOn '${item.endsOn}' precedes startsOn '${item.startsOn}': a calendar item cannot end before it begins`,
    );
  }

  const endExclusive = addCalendarDays(endInclusive, 1);

  const subject =
    item.dayPart === null ? item.label : `${item.label} (${DAY_PART_SUFFIX[item.dayPart]})`;

  return {
    subject,
    isAllDay: true,
    // Graph wants a local date-time with no offset, plus the zone beside it.
    start: { dateTime: `${formatDate(start.year, start.month, start.day)}T00:00:00`, timeZone },
    end: {
      dateTime: `${formatDate(endExclusive.year, endExclusive.month, endExclusive.day)}T00:00:00`,
      timeZone,
    },
    showAs: 'oof',
    categories: [item.kind],
  };
}

/**
 * The exact string the sync hash is taken over.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * projections built by different code paths could serialise differently and
 * defeat the no-op guard — a redelivered amend would PATCH for no reason, every
 * time. Sorting keys recursively makes the string a function of the *value*.
 *
 * It is deliberately the **projection** that is canonicalised, not the source
 * item: the guard's question is "would pushing this change what Outlook holds",
 * and a source field that does not reach the projection cannot change it.
 */
export function canonicalProjectionJson(projection: OutlookEventProjection): string {
  return JSON.stringify(sortValue(projection as unknown as JsonValue));
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key] as JsonValue);
    }
    return sorted;
  }
  return value;
}
