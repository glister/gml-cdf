import { describe, expect, it } from 'vitest';
import {
  cadenceDays,
  firstOccurrence,
  nextOccurrence,
  ReminderSpecError,
  untilReached,
  type ReminderZone,
} from './reminder.js';

/**
 * Core plan 10 §10 — the pure half of PL-020/ON-049.
 *
 * The tests worth their ink here are the two nobody writes until it breaks in
 * production: **the daylight-saving boundary** (a daily chase must not drift an
 * hour twice a year) and **the backlog** (a worker that was down for a week must
 * produce one chase, not seven). Everything else is arithmetic.
 */

const LONDON: ReminderZone = { timeZone: 'Europe/London' };
const NEW_YORK: ReminderZone = { timeZone: 'America/New_York' };

/** What a wall clock reads in a zone — the assertion these tests care about. */
function localTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
}

describe('cadenceDays', () => {
  it.each([
    ['P1D', 1],
    ['P3D', 3],
    ['P1W', 7],
    ['P2W', 14],
    ['P30D', 30],
  ])('reads %s as %i days', (cadence, days) => {
    expect(cadenceDays(cadence)).toBe(days);
  });

  it.each(['P1M', 'P1Y', 'PT1H', '1D', 'P', 'daily', '', 'P1.5D', 'P-1D'])(
    'rejects the unsupported cadence %s',
    (cadence) => {
      expect(() => cadenceDays(cadence)).toThrow(ReminderSpecError);
    },
  );

  it('rejects a zero-length cadence rather than looping forever', () => {
    // The failure this prevents is not a wrong date — it is a scheduler that
    // fires the same occurrence continuously because "next" is always "now".
    expect(() => cadenceDays('P0D')).toThrow(/zero-length/);
    expect(() => cadenceDays('P0W')).toThrow(/zero-length/);
  });
});

describe('firstOccurrence', () => {
  const now = new Date('2026-08-07T09:15:00.000Z');

  it('starts immediately when there is no anchor to hang off', () => {
    expect(firstOccurrence({ mode: 'from_now' }, now, LONDON)).toEqual(now);
  });

  it('offsets from a resolved deadline, preserving its local time of day', () => {
    // A task due 17:00 London on 11 August, chased from two days before.
    const dueAt = new Date('2026-08-11T16:00:00.000Z'); // 17:00 BST
    const first = firstOccurrence({ mode: 'instant', at: dueAt, offsetDays: -2 }, now, LONDON);
    expect(localTime(first, 'Europe/London')).toBe('09/08/2026, 17:00');
  });

  it('offsets a zero-day instant anchor to the anchor itself', () => {
    const dueAt = new Date('2026-08-11T16:00:00.000Z');
    expect(firstOccurrence({ mode: 'instant', at: dueAt, offsetDays: 0 }, now, LONDON)).toEqual(
      dueAt,
    );
  });

  // ON-049: "notification timing schedulable relative to the start date
  // (before/after day one)". The negative case is the requirement.
  it('places a chase three days BEFORE a calendar start date (ON-049)', () => {
    const first = firstOccurrence(
      { mode: 'date', date: '2026-09-01', offsetDays: -3, timeOfDay: '09:00' },
      now,
      LONDON,
    );
    expect(localTime(first, 'Europe/London')).toBe('29/08/2026, 09:00');
  });

  it('places a chase after a calendar start date too', () => {
    const first = firstOccurrence(
      { mode: 'date', date: '2026-09-01', offsetDays: 5, timeOfDay: '09:00' },
      now,
      LONDON,
    );
    expect(localTime(first, 'Europe/London')).toBe('06/09/2026, 09:00');
  });

  it('crosses a month boundary in the calendar, not in milliseconds', () => {
    const first = firstOccurrence(
      { mode: 'date', date: '2026-03-02', offsetDays: -5, timeOfDay: '09:00' },
      now,
      LONDON,
    );
    expect(localTime(first, 'Europe/London')).toBe('25/02/2026, 09:00');
  });

  it('does not clamp an occurrence that has already passed', () => {
    // A task raised after its own deadline is genuinely overdue. Pretending
    // otherwise would silently move a business deadline.
    const dueAt = new Date('2026-08-01T16:00:00.000Z');
    const first = firstOccurrence({ mode: 'instant', at: dueAt, offsetDays: 0 }, now, LONDON);
    expect(first.getTime()).toBeLessThan(now.getTime());
  });

  it.each(['14/09/2026', '2026-9-14', '2026-02-31', '2026-13-01', 'tomorrow'])(
    'rejects the malformed anchor date %s',
    (date) => {
      expect(() =>
        firstOccurrence({ mode: 'date', date, offsetDays: 0, timeOfDay: '09:00' }, now, LONDON),
      ).toThrow(ReminderSpecError);
    },
  );

  it.each(['9am', '25:00', '09:60', '9:00'])(
    'rejects the malformed time-of-day %s',
    (timeOfDay) => {
      expect(() =>
        firstOccurrence(
          { mode: 'date', date: '2026-09-01', offsetDays: 0, timeOfDay },
          now,
          LONDON,
        ),
      ).toThrow(ReminderSpecError);
    },
  );
});

describe('nextOccurrence', () => {
  it('advances one cadence step past the last occurrence', () => {
    const lastDue = new Date('2026-08-07T08:00:00.000Z');
    const now = new Date('2026-08-07T08:05:00.000Z');
    const next = nextOccurrence('P1D', lastDue, now, LONDON, { occurrence: 1 });
    expect(next).toEqual(new Date('2026-08-08T08:00:00.000Z'));
  });

  it('reads a weekly cadence as seven days', () => {
    const lastDue = new Date('2026-08-07T08:00:00.000Z');
    const now = new Date('2026-08-07T08:05:00.000Z');
    expect(nextOccurrence('P1W', lastDue, now, LONDON, { occurrence: 1 })).toEqual(
      new Date('2026-08-14T08:00:00.000Z'),
    );
  });

  // The DST test. Adding 86_400_000 ms across the boundary would give 08:00 or
  // 10:00 local; a daily chase must keep its wall clock.
  it('keeps its local time of day across the autumn clock change (BST → GMT)', () => {
    // UK clocks go back at 02:00 BST on Sunday 25 October 2026.
    const lastDue = new Date('2026-10-24T08:00:00.000Z'); // 09:00 BST
    const now = new Date('2026-10-24T08:05:00.000Z');
    const next = nextOccurrence('P1D', lastDue, now, LONDON, { occurrence: 1 });
    expect(localTime(next!, 'Europe/London')).toBe('25/10/2026, 09:00');
    // …and the UTC instant genuinely moved by 25 hours, which is the point.
    expect(next!.getTime() - lastDue.getTime()).toBe(25 * 3_600_000);
  });

  it('keeps its local time of day across the spring clock change (GMT → BST)', () => {
    // UK clocks go forward at 01:00 GMT on Sunday 29 March 2026.
    const lastDue = new Date('2026-03-28T09:00:00.000Z'); // 09:00 GMT
    const now = new Date('2026-03-28T09:05:00.000Z');
    const next = nextOccurrence('P1D', lastDue, now, LONDON, { occurrence: 1 });
    expect(localTime(next!, 'Europe/London')).toBe('29/03/2026, 09:00');
    expect(next!.getTime() - lastDue.getTime()).toBe(23 * 3_600_000);
  });

  it('honours a zone other than the default', () => {
    // US clocks change on a different date from the UK's — the zone is a
    // parameter, not a constant, and this proves nothing is hardcoded.
    const lastDue = new Date('2026-11-01T04:00:00.000Z'); // 00:00 EDT
    const now = new Date('2026-11-01T04:05:00.000Z');
    const next = nextOccurrence('P1D', lastDue, now, NEW_YORK, { occurrence: 1 });
    expect(localTime(next!, 'America/New_York')).toBe('02/11/2026, 00:00');
  });

  // The backlog test. A week of downtime must not produce seven chases.
  it('collapses a missed backlog into a single next chase', () => {
    const lastDue = new Date('2026-08-01T08:00:00.000Z');
    const now = new Date('2026-08-08T09:30:00.000Z'); // a week late
    const next = nextOccurrence('P1D', lastDue, now, LONDON, { occurrence: 1 });
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
    // Still on the original rhythm — 09:00 London, the next day.
    expect(localTime(next!, 'Europe/London')).toBe('09/08/2026, 09:00');
  });

  it('collapses a weekly backlog on the weekly rhythm', () => {
    const lastDue = new Date('2026-06-01T08:00:00.000Z');
    const now = new Date('2026-07-01T08:00:00.000Z');
    const next = nextOccurrence('P1W', lastDue, now, LONDON, { occurrence: 1 });
    // 1 June + 5 weeks = 6 July; four weeks would still be behind `now`.
    expect(localTime(next!, 'Europe/London')).toBe('06/07/2026, 09:00');
  });

  it('stops when the occurrence ceiling is reached', () => {
    const lastDue = new Date('2026-08-07T08:00:00.000Z');
    const now = new Date('2026-08-07T08:05:00.000Z');
    expect(
      nextOccurrence('P1D', lastDue, now, LONDON, {
        occurrence: 5,
        until: { maxOccurrences: 5 },
      }),
    ).toBeNull();
  });

  it('keeps going below the occurrence ceiling', () => {
    const lastDue = new Date('2026-08-07T08:00:00.000Z');
    const now = new Date('2026-08-07T08:05:00.000Z');
    expect(
      nextOccurrence('P1D', lastDue, now, LONDON, {
        occurrence: 4,
        until: { maxOccurrences: 5 },
      }),
    ).not.toBeNull();
  });

  it('stops when the next occurrence would fall past the notAfter valve', () => {
    const lastDue = new Date('2026-08-07T08:00:00.000Z');
    const now = new Date('2026-08-07T08:05:00.000Z');
    expect(
      nextOccurrence('P1D', lastDue, now, LONDON, {
        occurrence: 1,
        until: { notAfter: new Date('2026-08-07T23:59:00.000Z') },
      }),
    ).toBeNull();
  });

  it('applies the notAfter valve to the rolled-forward occurrence, not the naive one', () => {
    // The naive next (2 Aug) is inside the valve; the real next (9 Aug) is not.
    // Checking the wrong one would keep a series alive past its own deadline.
    const lastDue = new Date('2026-08-01T08:00:00.000Z');
    const now = new Date('2026-08-08T09:30:00.000Z');
    expect(
      nextOccurrence('P1D', lastDue, now, LONDON, {
        occurrence: 1,
        until: { notAfter: new Date('2026-08-03T00:00:00.000Z') },
      }),
    ).toBeNull();
  });

  it('rejects an unsupported cadence rather than guessing an interval', () => {
    const lastDue = new Date('2026-08-07T08:00:00.000Z');
    expect(() => nextOccurrence('P1M', lastDue, lastDue, LONDON, { occurrence: 1 })).toThrow(
      ReminderSpecError,
    );
  });
});

describe('untilReached', () => {
  const at = new Date('2026-08-07T09:00:00.000Z');

  it('is false with no valves at all', () => {
    expect(untilReached(undefined, at, 99)).toBe(false);
    expect(untilReached({}, at, 99)).toBe(false);
  });

  it('permits the last allowed occurrence and refuses the one after', () => {
    expect(untilReached({ maxOccurrences: 3 }, at, 3)).toBe(false);
    expect(untilReached({ maxOccurrences: 3 }, at, 4)).toBe(true);
  });

  it('stops a chase already in flight once notAfter has passed', () => {
    // The case this exists for: the valve is reached by the clock while an
    // occurrence sits on the queue. Checking only at scheduling time would let
    // that one through.
    expect(untilReached({ notAfter: new Date('2026-08-07T08:00:00.000Z') }, at, 1)).toBe(true);
    expect(untilReached({ notAfter: new Date('2026-08-07T10:00:00.000Z') }, at, 1)).toBe(false);
  });

  it('trips on either valve independently', () => {
    const until = { notAfter: new Date('2026-08-08T00:00:00.000Z'), maxOccurrences: 10 };
    expect(untilReached(until, at, 11)).toBe(true);
    expect(untilReached(until, new Date('2026-08-09T00:00:00.000Z'), 1)).toBe(true);
    expect(untilReached(until, at, 1)).toBe(false);
  });
});
