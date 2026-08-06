/**
 * Due-date resolution (core plan 08 §9.2, PL-013) — pure, with time passed in.
 *
 * A task's due date is expressed one of three ways: not at all, as an absolute
 * instant, or **relative to a named anchor** the raising module owns
 * (`start_date − 3d`). The third is the one that carries the requirement: the
 * spec is stored alongside the resolved value, so when the anchor moves — a
 * start date is pushed back a week — the resolution is re-run rather than lost
 * (ON-044/049).
 *
 * Two decisions are worth their ink.
 *
 * **The engine defines no anchor vocabulary.** `start_date`, `leaving_date`,
 * `review_date` are strings supplied by the caller with their values. An anchor
 * the caller did not supply is an `UnknownAnchorError`, never a silent "today":
 * a task due on a date nobody chose is worse than a task that fails to raise.
 *
 * **Local time-of-day, not midnight.** "Due on the 11th" means end of the
 * working day in Europe/London, which is a different UTC instant in June and in
 * December. The zone conversion is done with `Intl` against an explicit instant
 * and an explicit zone — deterministic, and the only alternative would be
 * hardcoding EU daylight-saving rules in this file.
 */

/** A due-date specification: the stored `due_mode` and its parameters. */
export type DueSpec =
  | { mode: 'none' }
  | { mode: 'absolute'; dueAt: Date }
  | { mode: 'anchor_relative'; anchorName: string; offsetDays: number };

/** Anchor name → calendar date (`YYYY-MM-DD`), supplied by the raising module. */
export type AnchorMap = Readonly<Record<string, string>>;

export interface DueDateOptions {
  /** Local time the resolved date falls due, `HH:MM` (config, §6). */
  timeOfDay: string;
  /** IANA zone the local time is interpreted in, e.g. `Europe/London`. */
  timeZone: string;
}

/** The caller asked to resolve against an anchor it did not supply a value for. */
export class UnknownAnchorError extends Error {
  constructor(
    readonly anchorName: string,
    readonly available: readonly string[],
  ) {
    super(
      `no value supplied for anchor '${anchorName}' (have: ${available.length > 0 ? available.join(', ') : 'none'}) — refusing to guess a due date`,
    );
    this.name = 'UnknownAnchorError';
  }
}

/** A malformed anchor value, time-of-day or zone. Fail loudly, never default. */
export class DueDateSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DueDateSpecError';
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

/**
 * The zone's UTC offset in milliseconds at a given instant.
 *
 * Formats the instant in the target zone, reads the fields back as if they were
 * UTC, and takes the difference. This is the standard offset probe; it needs no
 * dependency and stays a deterministic function of (instant, zone).
 */
function zoneOffsetMs(instant: number, timeZone: string): number {
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
    if (!found) throw new DueDateSpecError(`time zone '${timeZone}' produced no ${type} field`);
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

const DAY_MS = 86_400_000;

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
 *
 * Neither case can arise for the 17:00 default — they are here because a
 * configured `due.time_of_day` is a value someone can change, and "the engine
 * only works for one time of day" is not a property worth shipping.
 */
function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

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
function addDays(year: number, month: number, day: number, days: number): [number, number, number] {
  // UTC arithmetic on a date-only value is safe: no zone is involved yet, and
  // `Date.UTC` normalises month/day overflow (31 Jan + 1 = 1 Feb) for us.
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()];
}

function parseDate(value: string, what: string): [number, number, number] {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new DueDateSpecError(`${what} must be a calendar date 'YYYY-MM-DD', got '${value}'`);
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
    throw new DueDateSpecError(`${what} '${value}' is not a real calendar date`);
  }
  return [year, month, day];
}

function parseTimeOfDay(value: string): [number, number] {
  const match = TIME_PATTERN.exec(value);
  if (!match) {
    throw new DueDateSpecError(`due time-of-day must be 'HH:MM', got '${value}'`);
  }
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  if (hour > 23 || minute > 59) {
    throw new DueDateSpecError(`due time-of-day '${value}' is not a real time`);
  }
  return [hour, minute];
}

/**
 * Resolve a due specification to a concrete instant, or `null` for `none`.
 *
 * `absolute` passes through untouched — an instant chosen explicitly is not
 * re-interpreted against a time-of-day policy. `anchor_relative` shifts the
 * anchor's calendar date by the signed offset and lands it at the configured
 * local time.
 */
export function resolveDueDate(
  spec: DueSpec,
  anchors: AnchorMap,
  options: DueDateOptions,
): Date | null {
  if (spec.mode === 'none') return null;
  if (spec.mode === 'absolute') return spec.dueAt;

  const anchorValue = anchors[spec.anchorName];
  if (anchorValue === undefined) {
    throw new UnknownAnchorError(spec.anchorName, Object.keys(anchors));
  }

  const [year, month, day] = parseDate(anchorValue, `anchor '${spec.anchorName}'`);
  const [hour, minute] = parseTimeOfDay(options.timeOfDay);
  const [dueYear, dueMonth, dueDay] = addDays(year, month, day, spec.offsetDays);
  return zonedInstant(dueYear, dueMonth, dueDay, hour, minute, options.timeZone);
}

/**
 * Would re-resolving this task's due date change it?
 *
 * Used by `recomputeDueDates` to decide which rows to touch and journal: a task
 * whose anchor moved but whose resolved instant is unchanged is not a fact worth
 * recording. Equality is by instant, not by object identity.
 */
export function dueDateChanged(current: Date | null, next: Date | null): boolean {
  if (current === null || next === null) return current !== next;
  return current.getTime() !== next.getTime();
}
