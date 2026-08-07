import {
  addCalendarDays,
  DAY_MS,
  parseCalendarDate,
  parseTimeOfDay,
  rebadgeZonedTimeError,
  wallClockIn,
  zonedInstant,
  ZonedTimeError,
} from '../lib/zoned-time.js';

/**
 * Reminder cadence arithmetic (core plan 10 §9.2, PL-020 / ON-049) — pure, with
 * time passed in.
 *
 * This engine answers exactly two questions and refuses to answer any others:
 * **when does the first chase go out**, and **when does the next one**. Whether
 * a chase should go out at all is a satisfaction check against a live row, which
 * is I/O and lives in the worker (ADR-0009).
 *
 * Three decisions carry the requirement.
 *
 * **A cadence is a wall clock, not a duration in milliseconds.** "Chase daily at
 * 09:00" means 09:00 local every day, including the two days a year when adding
 * 24 hours to yesterday's instant gives 08:00 or 10:00. Every step here is
 * calendar arithmetic in an explicit zone, so a chase does not drift an hour
 * twice a year and then drift back.
 *
 * **The first occurrence can be before the anchor** (ON-049). A negative offset
 * is the whole point of the requirement — "remind them three days *before* their
 * start date" — so the offset is signed and nothing here treats a past-relative
 * occurrence as an error.
 *
 * **A backlog collapses into one chase, not a burst.** If the worker was down
 * for a week, `nextOccurrence` rolls forward in whole cadence steps until it is
 * genuinely in the future, so the recipient gets today's chase rather than seven
 * of them. Suppressing that burst is the difference between a reminder system
 * people read and one they filter.
 */

/** A malformed cadence, anchor or valve. Fail loudly, never default. */
export class ReminderSpecError extends ZonedTimeError {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderSpecError';
  }
}

/** Re-badge a shared zoned-time complaint as this engine's own error type. */
const asReminderSpec = <T>(fn: () => T): T =>
  rebadgeZonedTimeError(fn, (message) => new ReminderSpecError(message));

/** The zone a cadence's wall clock is interpreted in (config, core plan 08 §6). */
export interface ReminderZone {
  /** IANA zone, e.g. `Europe/London`. */
  timeZone: string;
}

/**
 * How the first chase is placed. Three shapes, because three genuinely
 * different things schedule reminders today:
 *
 *  - `from_now` — no deadline to hang off, so chasing starts immediately. Core
 *    plan 08's `no_due_date: 'from_raise'` and core plan 09's approval chases.
 *  - `instant` — relative to an already-resolved deadline (a task's `due_at`).
 *  - `date` — relative to a **calendar date** the business named (a start date),
 *    landing at a configured local time. This is ON-049's shape, and the only
 *    one that needs the zone: "three days before they start" is a date in a
 *    place, not an instant.
 */
export type ReminderAnchor =
  | { mode: 'from_now' }
  | { mode: 'instant'; at: Date; offsetDays: number }
  | { mode: 'date'; date: string; offsetDays: number; timeOfDay: string };

/** The safety valves that end a series regardless of satisfaction (§4.5). */
export interface ReminderUntil {
  /** Stop once the next occurrence would fall after this instant. */
  notAfter?: Date;
  /** Stop once this many chases have been sent. */
  maxOccurrences?: number;
}

const CADENCE_PATTERN = /^P(\d+)([DW])$/;

/**
 * An ISO-8601 day/week duration as whole days.
 *
 * Deliberately narrow. The registered cadence schemas admit only `P<n>D` and
 * `P<n>W`, so there is no month or year arithmetic to get wrong — and "chase
 * every month" is not a rhythm any Phase 1 requirement asks for. `P0D` is
 * rejected because a zero-length cadence is an infinite loop wearing a
 * configuration's clothes.
 */
export function cadenceDays(cadence: string): number {
  const match = CADENCE_PATTERN.exec(cadence);
  if (!match) {
    throw new ReminderSpecError(
      `'${cadence}' is not a supported reminder cadence — use an ISO-8601 day or week duration, e.g. P1D`,
    );
  }
  const amount = Number(match[1]);
  if (amount < 1) {
    throw new ReminderSpecError(
      `reminder cadence '${cadence}' is zero-length — a chase that repeats instantly would never stop`,
    );
  }
  return match[2] === 'W' ? amount * 7 : amount;
}

/**
 * When the first chase falls due.
 *
 * Note what this does **not** do: it does not clamp a computed instant that has
 * already passed. A task raised after its own deadline, or a reminder anchored
 * three days before a start date that was yesterday, is genuinely already
 * overdue — and the honest behaviour is to fire on the next scheduler pass
 * rather than to pretend the deadline is tomorrow.
 */
export function firstOccurrence(anchor: ReminderAnchor, now: Date, zone: ReminderZone): Date {
  switch (anchor.mode) {
    case 'from_now':
      return now;
    case 'instant':
      // A resolved instant already carries its own local time; shifting it by
      // whole days has to preserve that wall clock, or a `-2 day` offset from a
      // 17:00 deadline lands at 16:00 across a DST boundary.
      return shiftDays(anchor.at, anchor.offsetDays, zone.timeZone);
    case 'date':
      return asReminderSpec(() => {
        const date = parseCalendarDate(anchor.date, 'reminder anchor date');
        const { hour, minute } = parseTimeOfDay(anchor.timeOfDay);
        return zonedInstant(
          addCalendarDays({ ...date, hour, minute }, anchor.offsetDays),
          zone.timeZone,
        );
      });
  }
}

/**
 * When the chase after `lastDue` falls due, or `null` if a valve ends the series.
 *
 * `occurrence` is the number of the chase **just sent**, so the valve check asks
 * whether another one is allowed rather than whether this one was.
 *
 * The roll-forward loop is the part worth reading. A pending occurrence that sat
 * undelivered for a week must not produce seven chases when the worker comes
 * back: the series steps forward in whole cadence intervals until it lands in
 * the future, which keeps the rhythm anchored to the original time of day while
 * collapsing the backlog into a single next chase.
 */
export function nextOccurrence(
  cadence: string,
  lastDue: Date,
  now: Date,
  zone: ReminderZone,
  options: { occurrence: number; until?: ReminderUntil } = { occurrence: 1 },
): Date | null {
  const days = cadenceDays(cadence);
  const { occurrence, until } = options;

  if (until?.maxOccurrences !== undefined && occurrence >= until.maxOccurrences) return null;

  let next = shiftDays(lastDue, days, zone.timeZone);
  // Bounded by construction: each step advances by at least a day, so a
  // `lastDue` far enough in the past to loop is a `lastDue` far enough in the
  // past that the loop terminates in (gap / cadence) iterations.
  while (next.getTime() <= now.getTime()) {
    next = shiftDays(next, days, zone.timeZone);
  }

  if (until?.notAfter !== undefined && next.getTime() > until.notAfter.getTime()) return null;
  return next;
}

/**
 * Has a series exhausted its valves *before* sending occurrence `occurrence`?
 *
 * Checked by the handler on arrival as well as when scheduling the next one,
 * because a valve can be reached by the clock while an occurrence is already in
 * flight — and a `notAfter` that has passed should stop the chase that is about
 * to go out, not only the one after it.
 */
export function untilReached(
  until: ReminderUntil | undefined,
  at: Date,
  occurrence: number,
): boolean {
  if (!until) return false;
  if (until.maxOccurrences !== undefined && occurrence > until.maxOccurrences) return true;
  if (until.notAfter !== undefined && at.getTime() > until.notAfter.getTime()) return true;
  return false;
}

/**
 * Shift an instant by whole days, preserving its local wall clock.
 *
 * The reason this is not `+ days * DAY_MS`: across a daylight-saving boundary
 * that arithmetic moves the chase an hour, and then an hour back six months
 * later. A reminder that arrives at 08:00 half the year because of an
 * implementation detail is the kind of small wrongness nobody reports and
 * everybody notices.
 *
 * A wall clock that does not exist on the target day (the spring-forward hour)
 * resolves the same way every deadline in this codebase does — forward past the
 * gap; see `zonedInstant`.
 */
function shiftDays(from: Date, days: number, timeZone: string): Date {
  if (days === 0) return from;
  const clock = wallClockIn(from, timeZone);
  const shifted = zonedInstant(addCalendarDays(clock, days), timeZone);
  // `wallClockIn` reads to whole minutes, so a source instant carrying seconds
  // would silently lose them. Reminder due-times are minute-granular by
  // construction; carrying the remainder keeps the function total anyway.
  const subMinute = from.getTime() % 60_000;
  return new Date(shifted.getTime() + subMinute);
}

/** Exported for the tests and for callers computing a plain interval. */
export const REMINDER_DAY_MS = DAY_MS;
