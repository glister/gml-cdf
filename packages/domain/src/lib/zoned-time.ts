/**
 * Wall-clock arithmetic in an IANA time zone — pure, deterministic, `Intl`-only.
 *
 * Extracted from core plan 08's `tasks/due-date.ts` when core plan 10's reminder
 * engine needed the same machinery (its §9.2). Nothing here changed in the move;
 * it lives in `lib/` because "what instant is 17:00 on the 11th in Europe/London"
 * is not a fact about due dates or about reminders, and two copies of a
 * daylight-saving resolution is one copy too many.
 *
 * The rule these functions exist to serve: **a business time is a wall clock in
 * a place, not a number of milliseconds.** "Chase them daily at 09:00" means
 * 09:00 local every day, including the two days a year when adding 24 hours to
 * yesterday's instant would give 08:00 or 10:00.
 */

/** A malformed date, time-of-day or zone. Fail loudly, never default. */
export class ZonedTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZonedTimeError';
  }
}

/**
 * Run a helper here and re-badge its complaint as the caller's own error type.
 *
 * These functions know nothing about due dates or reminders, so they raise the
 * generic `ZonedTimeError`. Their callers each publish a specific subclass and
 * their tests assert on it — this keeps that contract without either engine
 * duplicating the parsing, and without a caller having to learn a second error
 * type because a function moved file. The message is identical either way.
 */
export function rebadgeZonedTimeError<T, E extends ZonedTimeError>(
  fn: () => T,
  make: (message: string) => E,
): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ZonedTimeError && error.constructor === ZonedTimeError) {
      throw make(error.message);
    }
    throw error;
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

export const DAY_MS = 86_400_000;

/** A wall-clock reading: calendar date plus time of day, in some zone. */
export interface WallClock {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * The zone's UTC offset in milliseconds at a given instant.
 *
 * Formats the instant in the target zone, reads the fields back as if they were
 * UTC, and takes the difference. This is the standard offset probe; it needs no
 * dependency and stays a deterministic function of (instant, zone).
 */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new ZonedTimeError(`time zone '${timeZone}' produced no ${type} field`);
    // `24` is how some locales render midnight; Date.UTC normalises it anyway.
    return Number(found.value);
  };

  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return asUtc - instant;
}

/** Read an instant as a wall clock in `timeZone`. The inverse of {@link zonedInstant}. */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(instant.getTime(), timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * The instant at which `YYYY-MM-DD HH:MM` occurs in `timeZone`.
 *
 * The offset depends on the instant we are solving for, so this probes the zone
 * either side of the target day, turns each probed offset into a candidate
 * instant, and keeps the candidates that really do render as the requested wall
 * clock. Two local times a year defeat a single probe:
 *
 *  - **The hour that does not exist** (spring forward): no candidate is valid,
 *    so the latest is taken — the standard "push past the gap" resolution, so
 *    01:30 on a spring-forward Sunday becomes 02:30 rather than 00:30.
 *  - **The hour that happens twice** (autumn back): two candidates are valid and
 *    the earlier is taken. For a deadline, earlier is the stricter reading, and
 *    it matches what every date library does.
 */
export function zonedInstant(clock: WallClock, timeZone: string): Date {
  const wallClock = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    0,
    0,
  );

  const candidates = new Set<number>();
  for (const probe of [wallClock - DAY_MS, wallClock, wallClock + DAY_MS]) {
    candidates.add(wallClock - zoneOffsetMs(probe, timeZone));
  }

  // A candidate is real iff rendering it in the zone gives back the wall clock
  // we asked for — which is exactly `wallClock - candidate === offset(candidate)`.
  const valid = [...candidates].filter((ts) => wallClock - ts === zoneOffsetMs(ts, timeZone));
  return new Date(valid.length > 0 ? Math.min(...valid) : Math.max(...candidates));
}

/** Add whole days to a calendar date, in the calendar — never in milliseconds. */
export function addCalendarDays(clock: WallClock, days: number): WallClock {
  // UTC arithmetic on a date-only value is safe: no zone is involved yet, and
  // `Date.UTC` normalises month/day overflow (31 Jan + 1 = 1 Feb) for us.
  const shifted = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: clock.hour,
    minute: clock.minute,
  };
}

/** Parse `YYYY-MM-DD`, rejecting values that are not real calendar dates. */
export function parseCalendarDate(value: string, what: string): WallClock {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new ZonedTimeError(`${what} must be a calendar date 'YYYY-MM-DD', got '${value}'`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Round-trip check: `Date.UTC` happily normalises 2026-02-31 into March, and a
  // due date silently moved by a typo is exactly the class of bug this rejects.
  const round = new Date(Date.UTC(year, month - 1, day));
  if (
    round.getUTCFullYear() !== year ||
    round.getUTCMonth() + 1 !== month ||
    round.getUTCDate() !== day
  ) {
    throw new ZonedTimeError(`${what} '${value}' is not a real calendar date`);
  }
  return { year, month, day, hour: 0, minute: 0 };
}

/** Parse `HH:MM`, rejecting values that are not real times of day. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(value);
  if (!match) {
    throw new ZonedTimeError(`time-of-day must be 'HH:MM', got '${value}'`);
  }
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  if (hour > 23 || minute > 59) {
    throw new ZonedTimeError(`time-of-day '${value}' is not a real time`);
  }
  return { hour, minute };
}
