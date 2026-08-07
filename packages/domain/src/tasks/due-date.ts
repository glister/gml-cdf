import {
  addCalendarDays,
  parseCalendarDate,
  parseTimeOfDay,
  rebadgeZonedTimeError,
  zonedInstant,
  ZonedTimeError,
} from '../lib/zoned-time.js';

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
 *
 * That conversion now lives in `../lib/zoned-time.js`, moved there unchanged
 * when core plan 10's reminder engine needed the same daylight-saving
 * resolution. `DueDateSpecError` is retained as a subclass so existing call
 * sites and their `instanceof` checks are untouched.
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
export class DueDateSpecError extends ZonedTimeError {
  constructor(message: string) {
    super(message);
    this.name = 'DueDateSpecError';
  }
}

/** Re-badge a shared zoned-time complaint as this engine's own error type. */
const asDueDateSpec = <T>(fn: () => T): T =>
  rebadgeZonedTimeError(fn, (message) => new DueDateSpecError(message));

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

  return asDueDateSpec(() => {
    const anchorDate = parseCalendarDate(anchorValue, `anchor '${spec.anchorName}'`);
    const { hour, minute } = parseTimeOfDay(options.timeOfDay);
    const due = addCalendarDays({ ...anchorDate, hour, minute }, spec.offsetDays);
    return zonedInstant(due, options.timeZone);
  });
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
