import type { CalendarEvent } from '@repo/trpc';

/**
 * The month/week grid's arithmetic (core plan 12 §5.3, PL-022).
 *
 * Pure functions over `YYYY-MM-DD` strings and week arrays, so the grid
 * component renders and nothing else. Dates stay **strings** end to end — the
 * feed returns them as `to_char(…, 'YYYY-MM-DD')` and comparisons are
 * lexicographic, which is exactly right for ISO dates and sidesteps the whole
 * class of bug where a UTC `Date` shifts a day either side of midnight.
 *
 * **No `date-fns`.** §5.3 suggested it; the arithmetic here is a fortnight's
 * worth of a library's smallest corner, and the repo already has a calendar-date
 * vocabulary in `@repo/domain` (`parseCalendarDate`, `addCalendarDays` — the
 * 2026-08-07 reconciliation entry asks plans to use it rather than adding
 * milliseconds). A second date library would be a second vocabulary; the eight
 * functions below are the whole need.
 */

/** Monday-first weekday labels — CDF is a UK client. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** `YYYY-MM-DD` for a UTC-noon date — noon so no timezone can shift the day. */
export function toKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parse `YYYY-MM-DD` at UTC noon. */
export function fromKey(key: string): Date {
  return new Date(`${key}T12:00:00Z`);
}

export function addDays(key: string, days: number): string {
  return toKey(new Date(fromKey(key).getTime() + days * 86_400_000));
}

/** Monday of the week containing `key`. */
export function startOfWeek(key: string): string {
  const day = fromKey(key).getUTCDay(); // 0 = Sunday
  return addDays(key, day === 0 ? -6 : 1 - day);
}

export function startOfMonth(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export function endOfMonth(key: string): string {
  const first = fromKey(startOfMonth(key));
  const nextMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1, 12));
  return addDays(toKey(nextMonth), -1);
}

export function addMonths(key: string, months: number): string {
  const d = fromKey(startOfMonth(key));
  return toKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, 12)));
}

export type CalendarView = 'month' | 'week';

/**
 * The window a view asks the feed for, and the weeks it renders.
 *
 * The month view's window covers the **whole grid**, not the calendar month:
 * the grid shows leading and trailing days from the adjacent months, and a bar
 * that starts on the 29th of the previous month has to be there to be drawn.
 */
export function gridFor(
  view: CalendarView,
  anchor: string,
): { weeks: string[][]; from: string; to: string } {
  const first = view === 'month' ? startOfWeek(startOfMonth(anchor)) : startOfWeek(anchor);
  const weekCount = view === 'month' ? weeksInMonthGrid(anchor) : 1;

  const weeks: string[][] = [];
  for (let w = 0; w < weekCount; w += 1) {
    const start = addDays(first, w * 7);
    weeks.push(Array.from({ length: 7 }, (_, d) => addDays(start, d)));
  }

  return { weeks, from: first, to: addDays(first, weekCount * 7 - 1) };
}

/** 4, 5 or 6 — a month grid is only ever one of those. */
function weeksInMonthGrid(anchor: string): number {
  const gridStart = startOfWeek(startOfMonth(anchor));
  const last = endOfMonth(anchor);
  const days =
    Math.round((fromKey(last).getTime() - fromKey(gridStart).getTime()) / 86_400_000) + 1;
  return Math.ceil(days / 7);
}

/** "August 2026", or "10 – 16 August 2026" for a week. */
export function periodTitle(view: CalendarView, anchor: string): string {
  if (view === 'month') {
    const d = fromKey(anchor);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const start = fromKey(startOfWeek(anchor));
  const end = fromKey(addDays(startOfWeek(anchor), 6));
  const endLabel = `${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${start.getUTCDate()} – ${endLabel}`
    : `${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]} – ${endLabel}`;
}

/** One drawn bar within one week row. */
export interface Segment {
  event: CalendarEvent;
  /** 0-based column the bar starts in. */
  colStart: number;
  /** How many columns it spans within this week. */
  span: number;
  /** The bar is a continuation from the previous week — square off that edge. */
  continuesLeft: boolean;
  /** It runs into the next week. */
  continuesRight: boolean;
  /** 0-based lane (row) within the week's bar area. */
  lane: number;
}

export interface WeekLayout {
  segments: Segment[];
  /** Per column: how many events were pushed past `maxLanes`. */
  overflow: number[];
}

/**
 * Lay a week's events into lanes.
 *
 * Greedy first-fit, and the events are taken in the feed's order — which is
 * already deterministic (`starts_on, kind, source_key, source_ref`). That
 * matters more than it looks: an unstable lane assignment makes bars jump rows
 * between two identical renders, which reads as a flicker bug rather than as a
 * calendar.
 *
 * Events beyond `maxLanes` are not drawn; they are counted per day so the cell
 * can offer "+N more". Counting per **day** rather than per event is what makes
 * the number match what a person sees when they open that day.
 */
export function layoutWeek(
  events: readonly CalendarEvent[],
  week: readonly string[],
  maxLanes: number,
): WeekLayout {
  const first = week[0]!;
  const last = week[6]!;
  const lanes: boolean[][] = [];
  const segments: Segment[] = [];
  const overflow = new Array<number>(7).fill(0);

  for (const event of events) {
    if (event.endsOn < first || event.startsOn > last) continue;

    const colStart = Math.max(0, dayIndex(week, event.startsOn));
    const colEnd = Math.min(6, dayIndex(week, event.endsOn));
    if (colEnd < colStart) continue;

    const lane = firstFreeLane(lanes, colStart, colEnd);
    if (lane >= maxLanes) {
      for (let c = colStart; c <= colEnd; c += 1) overflow[c] = (overflow[c] ?? 0) + 1;
      continue;
    }

    lanes[lane] ??= new Array<boolean>(7).fill(false);
    for (let c = colStart; c <= colEnd; c += 1) lanes[lane]![c] = true;

    segments.push({
      event,
      colStart,
      span: colEnd - colStart + 1,
      continuesLeft: event.startsOn < first,
      continuesRight: event.endsOn > last,
      lane,
    });
  }

  return { segments, overflow };
}

/** Column of `key` in `week`, or -1/7 when it falls outside. */
function dayIndex(week: readonly string[], key: string): number {
  if (key < week[0]!) return -1;
  if (key > week[6]!) return 7;
  return week.indexOf(key);
}

function firstFreeLane(lanes: boolean[][], from: number, to: number): number {
  for (let lane = 0; ; lane += 1) {
    const row = lanes[lane];
    if (!row) return lane;
    let free = true;
    for (let c = from; c <= to; c += 1) {
      if (row[c]) {
        free = false;
        break;
      }
    }
    if (free) return lane;
  }
}

/** Every event covering a day, in feed order — the day popover's list. */
export function eventsOnDay(events: readonly CalendarEvent[], key: string): CalendarEvent[] {
  return events.filter((e) => e.startsOn <= key && e.endsOn >= key);
}

/**
 * Organisation-wide items are drawn as a **background wash** on the day, not
 * only as a bar: a bank holiday or a shut-down is a property of the day itself,
 * and lane overflow must never be able to hide it (§5.3).
 */
export function dayWashKind(events: readonly CalendarEvent[], key: string): string | null {
  const hit = eventsOnDay(events, key).find(
    (e) =>
      e.personId === null &&
      (e.kind === 'bank_holiday' || e.kind === 'blackout' || e.kind === 'shutdown'),
  );
  return hit ? hit.kind : null;
}
