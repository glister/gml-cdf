import { describe, expect, it } from 'vitest';
import {
  canonicalProjectionJson,
  projectOutlookEvent,
  OutlookProjectionError,
  type OutlookProjectionInput,
} from './outlook-projection.js';

const TZ = 'Europe/London';

function item(overrides: Partial<OutlookProjectionInput> = {}): OutlookProjectionInput {
  return {
    label: 'Annual leave',
    startsOn: '2026-08-10',
    endsOn: '2026-08-14',
    dayPart: null,
    kind: 'leave',
    ...overrides,
  };
}

describe('projectOutlookEvent — the all-day boundary (§5.2)', () => {
  it('sends an exclusive end one day past the inclusive last day', () => {
    const projection = projectOutlookEvent(item(), TZ);

    expect(projection.start).toEqual({ dateTime: '2026-08-10T00:00:00', timeZone: TZ });
    // The person is away *through* the 14th, so Graph's half-open end is the 15th.
    expect(projection.end).toEqual({ dateTime: '2026-08-15T00:00:00', timeZone: TZ });
    expect(projection.isAllDay).toBe(true);
    expect(projection.showAs).toBe('oof');
  });

  it('projects a single day as a one-day span, not a zero-length one', () => {
    const projection = projectOutlookEvent(
      item({ startsOn: '2026-08-10', endsOn: '2026-08-10' }),
      TZ,
    );

    expect(projection.start.dateTime).toBe('2026-08-10T00:00:00');
    expect(projection.end.dateTime).toBe('2026-08-11T00:00:00');
  });

  it('rolls the exclusive end over a month boundary', () => {
    const projection = projectOutlookEvent(
      item({ startsOn: '2026-08-30', endsOn: '2026-08-31' }),
      TZ,
    );

    expect(projection.end.dateTime).toBe('2026-09-01T00:00:00');
  });

  it('rolls the exclusive end over a year boundary', () => {
    const projection = projectOutlookEvent(
      item({ startsOn: '2026-12-29', endsOn: '2026-12-31' }),
      TZ,
    );

    expect(projection.end.dateTime).toBe('2027-01-01T00:00:00');
  });

  it('rolls the exclusive end over a leap day', () => {
    const projection = projectOutlookEvent(
      item({ startsOn: '2028-02-28', endsOn: '2028-02-29' }),
      TZ,
    );

    expect(projection.end.dateTime).toBe('2028-03-01T00:00:00');
  });

  it('spans a British Summer Time change without gaining or losing a day', () => {
    // The clocks go back on 2026-10-25. A millisecond-based +1 day would land
    // this end at 23:00 the previous evening.
    const projection = projectOutlookEvent(
      item({ startsOn: '2026-10-23', endsOn: '2026-10-26' }),
      TZ,
    );

    expect(projection.start.dateTime).toBe('2026-10-23T00:00:00');
    expect(projection.end.dateTime).toBe('2026-10-27T00:00:00');
  });
});

describe('projectOutlookEvent — what reaches the subject line', () => {
  it('uses the label verbatim for a whole-day item', () => {
    expect(projectOutlookEvent(item(), TZ).subject).toBe('Annual leave');
  });

  it('names the half in the subject rather than inventing working hours', () => {
    expect(projectOutlookEvent(item({ dayPart: 'am' }), TZ).subject).toBe('Annual leave (morning)');
    expect(projectOutlookEvent(item({ dayPart: 'pm' }), TZ).subject).toBe(
      'Annual leave (afternoon)',
    );
    // Still all-day: Outlook has no half-day, and a timed event would need
    // working hours nobody has configured.
    expect(projectOutlookEvent(item({ dayPart: 'am' }), TZ).isAllDay).toBe(true);
  });

  it("carries a restricted source's injected label and nothing else", () => {
    // SA-023: what the composer injected is all the projection can see, so the
    // Outlook event cannot say more than the shared calendar does.
    const projection = projectOutlookEvent(item({ label: 'Absence', kind: 'absence' }), TZ);

    expect(projection.subject).toBe('Absence');
    expect(projection.categories).toEqual(['absence']);
    expect(JSON.stringify(projection)).not.toContain('sick');
  });
});

describe('projectOutlookEvent — refusals', () => {
  it('refuses an inverted range rather than silently swapping it', () => {
    expect(() =>
      projectOutlookEvent(item({ startsOn: '2026-08-14', endsOn: '2026-08-10' }), TZ),
    ).toThrow(OutlookProjectionError);
  });

  it('refuses a date that is not a real calendar date', () => {
    expect(() => projectOutlookEvent(item({ endsOn: '2026-02-30' }), TZ)).toThrow();
    expect(() => projectOutlookEvent(item({ startsOn: '10/08/2026' }), TZ)).toThrow();
  });

  it('refuses to project without a timezone', () => {
    expect(() => projectOutlookEvent(item(), '')).toThrow(OutlookProjectionError);
  });
});

describe('canonicalProjectionJson — the hash guard depends on this being stable', () => {
  it('is identical for two projections of the same item', () => {
    expect(canonicalProjectionJson(projectOutlookEvent(item(), TZ))).toBe(
      canonicalProjectionJson(projectOutlookEvent(item(), TZ)),
    );
  });

  it('ignores key insertion order', () => {
    const projection = projectOutlookEvent(item(), TZ);
    // The same value, assembled in a different order — as a differently-written
    // future caller would produce. Without sorting, this is a spurious amend.
    const reordered = {
      categories: projection.categories,
      showAs: projection.showAs,
      end: { timeZone: projection.end.timeZone, dateTime: projection.end.dateTime },
      start: { timeZone: projection.start.timeZone, dateTime: projection.start.dateTime },
      isAllDay: projection.isAllDay,
      subject: projection.subject,
    } as typeof projection;

    expect(canonicalProjectionJson(reordered)).toBe(canonicalProjectionJson(projection));
  });

  it('changes when a date changes — the whole point of the guard', () => {
    const before = canonicalProjectionJson(projectOutlookEvent(item(), TZ));
    const after = canonicalProjectionJson(projectOutlookEvent(item({ endsOn: '2026-08-15' }), TZ));

    expect(after).not.toBe(before);
  });

  it('changes when the label changes', () => {
    const before = canonicalProjectionJson(projectOutlookEvent(item(), TZ));
    const after = canonicalProjectionJson(projectOutlookEvent(item({ label: 'Unpaid leave' }), TZ));

    expect(after).not.toBe(before);
  });

  it('changes when the timezone changes', () => {
    const before = canonicalProjectionJson(projectOutlookEvent(item(), TZ));
    const after = canonicalProjectionJson(projectOutlookEvent(item(), 'Europe/Dublin'));

    expect(after).not.toBe(before);
  });
});
