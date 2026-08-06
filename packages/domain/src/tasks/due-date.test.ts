import { describe, expect, it } from 'vitest';
import {
  dueDateChanged,
  resolveDueDate,
  DueDateSpecError,
  UnknownAnchorError,
} from './due-date.js';

/**
 * Core plan 08 §10, PL-013. The DST cases are the reason this function exists as
 * a function: "17:00 on the 11th" is a different UTC instant either side of the
 * clock change, and a task a day (or an hour) out is the failure mode §12.3
 * calls out.
 */

const LONDON = { timeOfDay: '17:00', timeZone: 'Europe/London' };

describe('resolveDueDate', () => {
  it('returns null for a task with no due date', () => {
    expect(resolveDueDate({ mode: 'none' }, {}, LONDON)).toBeNull();
  });

  it('passes an absolute due date through untouched', () => {
    const dueAt = new Date('2026-09-11T09:30:00.000Z');
    expect(resolveDueDate({ mode: 'absolute', dueAt }, {}, LONDON)).toBe(dueAt);
  });

  it('resolves start_date − 3d to the configured local time (AC-D1)', () => {
    const due = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'start_date', offsetDays: -3 },
      { start_date: '2026-09-14' },
      LONDON,
    );
    // 2026-09-11 17:00 BST = 16:00Z.
    expect(due?.toISOString()).toBe('2026-09-11T16:00:00.000Z');
  });

  it('resolves a positive offset, crossing a month boundary', () => {
    const due = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'start_date', offsetDays: 5 },
      { start_date: '2026-09-28' },
      LONDON,
    );
    expect(due?.toISOString()).toBe('2026-10-03T16:00:00.000Z');
  });

  it('resolves a zero offset to the anchor day itself', () => {
    const due = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'due_date', offsetDays: 0 },
      { due_date: '2026-01-15' },
      LONDON,
    );
    // January: GMT, so 17:00 local is 17:00Z.
    expect(due?.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('is one hour apart across the spring clock change, not one day', () => {
    // The 2026 UK change is 29 March. Same wall-clock time, different offsets.
    const before = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'd', offsetDays: 0 },
      { d: '2026-03-28' },
      LONDON,
    );
    const after = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'd', offsetDays: 0 },
      { d: '2026-03-30' },
      LONDON,
    );
    expect(before?.toISOString()).toBe('2026-03-28T17:00:00.000Z'); // GMT
    expect(after?.toISOString()).toBe('2026-03-30T16:00:00.000Z'); // BST
  });

  it('handles the autumn clock change the same way', () => {
    // 2026 UK change back is 25 October.
    const before = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'd', offsetDays: 0 },
      { d: '2026-10-24' },
      LONDON,
    );
    const after = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'd', offsetDays: 0 },
      { d: '2026-10-26' },
      LONDON,
    );
    expect(before?.toISOString()).toBe('2026-10-24T16:00:00.000Z'); // BST
    expect(after?.toISOString()).toBe('2026-10-26T17:00:00.000Z'); // GMT
  });

  it('resolves a time inside the spring gap forward past it, not backwards', () => {
    // 01:30 on 29 March 2026 does not exist in London — the clocks jump 01:00→02:00.
    const due = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'd', offsetDays: 0 },
      { d: '2026-03-29' },
      { timeOfDay: '01:30', timeZone: 'Europe/London' },
    );
    // 01:30Z renders as 02:30 BST — pushed past the gap, not back before it.
    expect(due?.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('takes the first occurrence of an ambiguous autumn time', () => {
    // 01:30 on 25 October 2026 happens twice (BST then GMT).
    const due = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'd', offsetDays: 0 },
      { d: '2026-10-25' },
      { timeOfDay: '01:30', timeZone: 'Europe/London' },
    );
    expect(due?.toISOString()).toBe('2026-10-25T00:30:00.000Z'); // 01:30 BST
  });

  it('honours a non-UK zone', () => {
    const due = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'd', offsetDays: 0 },
      { d: '2026-07-01' },
      { timeOfDay: '09:00', timeZone: 'America/New_York' },
    );
    expect(due?.toISOString()).toBe('2026-07-01T13:00:00.000Z'); // EDT = UTC-4
  });

  it('rejects an anchor the caller did not supply rather than guessing', () => {
    expect(() =>
      resolveDueDate(
        { mode: 'anchor_relative', anchorName: 'leaving_date', offsetDays: -1 },
        { start_date: '2026-09-14' },
        LONDON,
      ),
    ).toThrow(UnknownAnchorError);
  });

  it('names the anchors it does have, so the caller can see the mismatch', () => {
    try {
      resolveDueDate(
        { mode: 'anchor_relative', anchorName: 'leaving_date', offsetDays: -1 },
        { start_date: '2026-09-14' },
        LONDON,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as UnknownAnchorError).anchorName).toBe('leaving_date');
      expect((error as Error).message).toContain('start_date');
    }
  });

  it.each([
    ['14/09/2026', 'not an ISO date'],
    ['2026-9-14', 'not zero-padded'],
    ['2026-02-31', 'not a real day'],
    ['2026-13-01', 'not a real month'],
  ])('rejects the malformed anchor value %s (%s)', (value) => {
    expect(() =>
      resolveDueDate(
        { mode: 'anchor_relative', anchorName: 'd', offsetDays: 0 },
        { d: value },
        LONDON,
      ),
    ).toThrow(DueDateSpecError);
  });

  it.each(['5pm', '25:00', '17:60', '17'])('rejects the malformed time-of-day %s', (timeOfDay) => {
    expect(() =>
      resolveDueDate(
        { mode: 'anchor_relative', anchorName: 'd', offsetDays: 0 },
        { d: '2026-09-14' },
        { timeOfDay, timeZone: 'Europe/London' },
      ),
    ).toThrow(DueDateSpecError);
  });

  it('shifts a leap day correctly', () => {
    const due = resolveDueDate(
      { mode: 'anchor_relative', anchorName: 'd', offsetDays: 1 },
      { d: '2028-02-28' },
      LONDON,
    );
    expect(due?.toISOString()).toBe('2028-02-29T17:00:00.000Z');
  });
});

describe('dueDateChanged', () => {
  it('is false for the same instant expressed as two objects', () => {
    expect(dueDateChanged(new Date('2026-09-11T16:00:00Z'), new Date('2026-09-11T16:00:00Z'))).toBe(
      false,
    );
  });

  it('is false when both are absent', () => {
    expect(dueDateChanged(null, null)).toBe(false);
  });

  it('is true when a date appears, disappears or moves', () => {
    const date = new Date('2026-09-11T16:00:00Z');
    expect(dueDateChanged(null, date)).toBe(true);
    expect(dueDateChanged(date, null)).toBe(true);
    expect(dueDateChanged(date, new Date('2026-09-18T16:00:00Z'))).toBe(true);
  });
});
