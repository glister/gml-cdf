import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '@repo/trpc';
import {
  addDays,
  addMonths,
  dayWashKind,
  endOfMonth,
  eventsOnDay,
  gridFor,
  layoutWeek,
  periodTitle,
  startOfWeek,
} from './calendar-grid';

/**
 * The grid's arithmetic (core plan 12 §9.4).
 *
 * These are the calculations a calendar gets wrong quietly: a bar that spans a
 * week boundary, a month whose grid needs six rows, a lane assignment that
 * shuffles between renders. None of them throw when they are wrong — they just
 * draw the wrong picture.
 */

function event(
  overrides: Partial<CalendarEvent> & Pick<CalendarEvent, 'startsOn' | 'endsOn'>,
): CalendarEvent {
  return {
    sourceKey: 'test',
    sourceRef: `${overrides.startsOn}-${overrides.endsOn}`,
    personId: null,
    personLabel: null,
    teamIds: [],
    dayPart: null,
    kind: 'leave',
    typeRef: null,
    label: 'Item',
    status: 'approved',
    visibilityClass: 'normal',
    colour: '#2563eb',
    ...overrides,
  };
}

describe('period arithmetic', () => {
  it('starts weeks on Monday', () => {
    expect(startOfWeek('2026-08-12')).toBe('2026-08-10'); // a Wednesday
    expect(startOfWeek('2026-08-10')).toBe('2026-08-10'); // already Monday
    expect(startOfWeek('2026-08-16')).toBe('2026-08-10'); // Sunday belongs back
  });

  it('finds the end of a month, including February in a leap year', () => {
    expect(endOfMonth('2026-08-14')).toBe('2026-08-31');
    expect(endOfMonth('2026-02-01')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-14')).toBe('2028-02-29');
  });

  it('adds months without landing on a day that does not exist', () => {
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-01');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-01');
  });

  it('adds days across a British Summer Time change', () => {
    // The clocks go back on 2026-10-25. Dates are UTC-noon strings precisely so
    // this cannot slip a day.
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
  });
});

describe('gridFor', () => {
  it('covers the whole month grid, not the calendar month', () => {
    // August 2026 starts on a Saturday, so the grid opens on 27 July.
    const { from, to, weeks } = gridFor('month', '2026-08-14');

    expect(from).toBe('2026-07-27');
    expect(weeks).toHaveLength(6);
    expect(to).toBe(addDays(from, 41));
    expect(weeks[0]![0]).toBe('2026-07-27');
    expect(weeks.at(-1)!.at(-1)).toBe(to);
  });

  it('produces a four-week grid for a February that fits exactly', () => {
    // February 2027 starts on a Monday and has 28 days.
    const { weeks } = gridFor('month', '2027-02-10');
    expect(weeks).toHaveLength(4);
  });

  it('asks for exactly seven days in the week view', () => {
    const { from, to, weeks } = gridFor('week', '2026-08-13');
    expect(weeks).toHaveLength(1);
    expect(from).toBe('2026-08-10');
    expect(to).toBe('2026-08-16');
  });

  it('never asks for a window the feed would refuse', () => {
    // The feed caps at 92 days; six weeks is 42.
    const { from, to } = gridFor('month', '2026-08-14');
    const days = (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBeLessThanOrEqual(92);
  });
});

describe('periodTitle', () => {
  it('names a month', () => {
    expect(periodTitle('month', '2026-08-14')).toBe('August 2026');
  });

  it('names a week within one month, and one that straddles two', () => {
    expect(periodTitle('week', '2026-08-13')).toBe('10 – 16 August 2026');
    expect(periodTitle('week', '2026-09-01')).toBe('31 August – 6 September 2026');
  });
});

describe('layoutWeek', () => {
  const week = gridFor('week', '2026-08-13').weeks[0]!;

  it('places a bar in the right columns', () => {
    const { segments } = layoutWeek(
      [event({ startsOn: '2026-08-11', endsOn: '2026-08-13' })],
      week,
      3,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ colStart: 1, span: 3, lane: 0 });
    expect(segments[0]!.continuesLeft).toBe(false);
    expect(segments[0]!.continuesRight).toBe(false);
  });

  it('clips a bar that runs in from the previous week and out into the next', () => {
    const { segments } = layoutWeek(
      [event({ startsOn: '2026-08-05', endsOn: '2026-08-20' })],
      week,
      3,
    );

    expect(segments[0]).toMatchObject({ colStart: 0, span: 7 });
    expect(segments[0]!.continuesLeft).toBe(true);
    expect(segments[0]!.continuesRight).toBe(true);
  });

  it('drops an event that misses the week entirely', () => {
    const { segments } = layoutWeek(
      [event({ startsOn: '2026-09-01', endsOn: '2026-09-02' })],
      week,
      3,
    );
    expect(segments).toEqual([]);
  });

  it('gives overlapping events separate lanes and reuses a freed one', () => {
    const { segments } = layoutWeek(
      [
        event({ startsOn: '2026-08-10', endsOn: '2026-08-11', sourceRef: 'a' }),
        event({ startsOn: '2026-08-10', endsOn: '2026-08-12', sourceRef: 'b' }),
        // Starts after 'a' ends, so it fits back on lane 0.
        event({ startsOn: '2026-08-13', endsOn: '2026-08-14', sourceRef: 'c' }),
      ],
      week,
      3,
    );

    expect(segments.map((s) => [s.event.sourceRef, s.lane])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
    ]);
  });

  it('counts overflow per day, not per event', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      event({ startsOn: '2026-08-10', endsOn: '2026-08-10', sourceRef: `e${i}` }),
    );
    const { segments, overflow } = layoutWeek(many, week, 3);

    expect(segments).toHaveLength(3);
    // Two pushed out, on Monday only.
    expect(overflow).toEqual([2, 0, 0, 0, 0, 0, 0]);
  });

  it('assigns the same lanes for the same input, twice', () => {
    const events = [
      event({ startsOn: '2026-08-10', endsOn: '2026-08-14', sourceRef: 'a' }),
      event({ startsOn: '2026-08-11', endsOn: '2026-08-12', sourceRef: 'b' }),
    ];
    const first = layoutWeek(events, week, 3).segments.map((s) => s.lane);
    const second = layoutWeek(events, week, 3).segments.map((s) => s.lane);

    expect(first).toEqual(second);
  });
});

describe('day helpers', () => {
  it('lists everything covering a day, inclusive at both ends', () => {
    const events = [
      event({ startsOn: '2026-08-10', endsOn: '2026-08-12', sourceRef: 'span' }),
      event({ startsOn: '2026-08-13', endsOn: '2026-08-13', sourceRef: 'after' }),
    ];

    expect(eventsOnDay(events, '2026-08-10').map((e) => e.sourceRef)).toEqual(['span']);
    expect(eventsOnDay(events, '2026-08-12').map((e) => e.sourceRef)).toEqual(['span']);
    expect(eventsOnDay(events, '2026-08-13').map((e) => e.sourceRef)).toEqual(['after']);
  });

  it('washes a day for an organisation-wide shut-down, but not for personal leave', () => {
    const shutdown = event({
      startsOn: '2026-08-24',
      endsOn: '2026-08-28',
      kind: 'shutdown',
      personId: null,
    });
    const leave = event({
      startsOn: '2026-08-24',
      endsOn: '2026-08-24',
      kind: 'leave',
      personId: '019018a0-0000-7000-8000-000000000001',
    });

    expect(dayWashKind([shutdown], '2026-08-26')).toBe('shutdown');
    expect(dayWashKind([leave], '2026-08-24')).toBeNull();
    expect(dayWashKind([shutdown], '2026-08-29')).toBeNull();
  });
});
