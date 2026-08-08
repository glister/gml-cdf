import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  bindingForEventType,
  canonicalFragment,
  syncEventTypes,
  validateCalendarSource,
  CalendarSourceError,
  CANONICAL_COLUMNS,
  type CalendarSource,
} from './registry.js';
import { DEMO_SOURCE_KEY } from './sources/demo.js';
import { CONFIG_PERIOD_SOURCE_KEY } from './sources/config-periods.js';

/**
 * Registration validity is a **boot** property (core plan 12 §12.3: "composer
 * validates fragment column set at registration — startup failure, not
 * runtime"). These assert the refusals; the composed SQL itself is proved
 * against real Postgres in `routers/platform/calendar.test.ts`.
 */

/** Compiles SQL without connecting — the fragment's text is all that is asserted. */
const compiler = new Kysely<never>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

function source(overrides: Partial<CalendarSource> = {}): CalendarSource {
  return {
    key: 'platform.example',
    kinds: ['leave'],
    visibilityClass: 'normal',
    fragment: () => sql`SELECT 1`,
    ...overrides,
  };
}

describe('validateCalendarSource', () => {
  it('accepts a well-formed source', () => {
    expect(() => validateCalendarSource(source())).not.toThrow();
  });

  it('requires a <module>.<name> key', () => {
    expect(() => validateCalendarSource(source({ key: 'leave' }))).toThrow(CalendarSourceError);
    expect(() => validateCalendarSource(source({ key: 'hr.leave.booking' }))).toThrow(
      CalendarSourceError,
    );
  });

  it('refuses a source that declares no kinds', () => {
    expect(() => validateCalendarSource(source({ kinds: [] }))).toThrow(/no kinds/);
  });

  it('refuses a restricted source with no constant label (SA-023)', () => {
    expect(() => validateCalendarSource(source({ visibilityClass: 'restricted' }))).toThrow(
      /restrictedLabel/,
    );
  });

  it('refuses a restricted label on a source that is not restricted', () => {
    // Silently ignoring it is worse: the author believes the rows are protected.
    expect(() => validateCalendarSource(source({ restrictedLabel: 'Absence' }))).toThrow(
      /not restricted/,
    );
  });

  it('refuses a binding that maps one event type to two operations', () => {
    expect(() =>
      validateCalendarSource(
        source({
          outlookSync: {
            onApproved: 'hr.leave_booking.approved',
            onCancelled: 'hr.leave_booking.approved',
            load: async () => null,
          },
        }),
      ),
    ).toThrow(/two sync operations/);
  });
});

describe('canonicalFragment', () => {
  it('projects the canonical columns in the fixed order', () => {
    const compiled = canonicalFragment(
      { key: 'platform.example', visibilityClass: 'normal' },
      {
        sourceRef: sql`x.id`,
        personId: sql`x.person_id`,
        startsOn: sql`x.starts_on`,
        endsOn: sql`x.ends_on`,
        kind: sql`'leave'`,
        label: sql`x.label`,
        status: sql`'approved'`,
      },
      sql`FROM example x`,
    ).compile(compiler);

    const aliases = [...compiled.sql.matchAll(/AS (\w+)/g)].map((m) => m[1]);
    expect(aliases).toEqual([...CANONICAL_COLUMNS]);
  });

  it('discards a restricted fragment’s label, type ref, label and colour', () => {
    const compiled = canonicalFragment(
      { key: 'hr.absence', visibilityClass: 'restricted', restrictedLabel: 'Absence' },
      {
        sourceRef: sql`x.id`,
        personId: sql`x.person_id`,
        startsOn: sql`x.starts_on`,
        endsOn: sql`x.ends_on`,
        kind: sql`'absence'`,
        typeRef: sql`x.sickness_type_id`,
        typeLabel: sql`x.sickness_type_name`,
        typeColour: sql`x.sickness_colour`,
        label: sql`x.medical_note`,
        status: sql`'approved'`,
      },
      sql`FROM hr.absence x`,
    ).compile(compiler);

    // Nothing the hostile fragment offered survives into the SQL text.
    expect(compiled.sql).not.toContain('medical_note');
    expect(compiled.sql).not.toContain('sickness_type_id');
    expect(compiled.sql).not.toContain('sickness_type_name');
    expect(compiled.sql).not.toContain('sickness_colour');
    expect(compiled.sql).toContain("'Absence'");
  });
});

describe('bindingForEventType', () => {
  it('resolves the pilot source’s three operations', () => {
    expect(bindingForEventType('platform.demo.calendar_item_approved')).toMatchObject({
      operation: 'create',
    });
    expect(bindingForEventType('platform.demo.calendar_item_rescheduled')).toMatchObject({
      operation: 'update',
    });
    expect(bindingForEventType('platform.demo.calendar_item_cancelled')).toMatchObject({
      operation: 'cancel',
    });
  });

  it('returns undefined for an event no source bound', () => {
    expect(bindingForEventType('platform.demo.pinged')).toBeUndefined();
  });

  it('lists exactly the bound event types — the subscription’s rule set', () => {
    expect(new Set(syncEventTypes())).toEqual(
      new Set([
        'platform.demo.calendar_item_approved',
        'platform.demo.calendar_item_rescheduled',
        'platform.demo.calendar_item_cancelled',
      ]),
    );
  });

  it('does not bind the config-period source — org-wide items have no calendar', () => {
    expect(bindingForEventType(CONFIG_PERIOD_SOURCE_KEY)).toBeUndefined();
    expect(DEMO_SOURCE_KEY).toBe('platform.demo_item');
  });
});
