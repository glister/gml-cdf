import { describe, expect, it } from 'vitest';
import { activeModulesFor, grantState, hasRole, isGrantActive, type Grant } from './grants.js';

/**
 * Boundary cases for the grant window and role resolution (core plan 04 §10).
 * Every instant is explicit — no clock, no mocks, no database (ADR-0009).
 */

const T = (iso: string) => new Date(iso);
const NOW = T('2026-07-28T12:00:00.000Z');

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    roleKey: 'hr_user',
    module: 'platform',
    validFrom: T('2026-01-01T00:00:00.000Z'),
    validUntil: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('isGrantActive / grantState — window boundaries', () => {
  it('an open-ended grant that has started is active', () => {
    const g = grant();
    expect(isGrantActive(g, NOW)).toBe(true);
    expect(grantState(g, NOW)).toBe('active');
  });

  it('valid_from exactly now is already active (start is inclusive)', () => {
    const g = grant({ validFrom: NOW });
    expect(isGrantActive(g, NOW)).toBe(true);
    expect(grantState(g, NOW)).toBe('active');
  });

  it('valid_from in the future does not authorise, and reads as pending', () => {
    const g = grant({ validFrom: T('2026-08-01T00:00:00.000Z') });
    expect(isGrantActive(g, NOW)).toBe(false);
    expect(grantState(g, NOW)).toBe('pending');
  });

  it('valid_until exactly now has already ended (end is exclusive)', () => {
    const g = grant({ validUntil: NOW });
    expect(isGrantActive(g, NOW)).toBe(false);
    expect(grantState(g, NOW)).toBe('expired');
  });

  it('one millisecond before valid_until still authorises', () => {
    const g = grant({ validUntil: new Date(NOW.getTime() + 1) });
    expect(isGrantActive(g, NOW)).toBe(true);
    expect(grantState(g, NOW)).toBe('active');
  });

  it('a past valid_until does not authorise even before the sweep revokes it', () => {
    const g = grant({ validUntil: T('2026-07-01T00:00:00.000Z') });
    expect(isGrantActive(g, NOW)).toBe(false);
    expect(grantState(g, NOW)).toBe('expired');
  });

  it('a revoked grant never authorises, even inside its window', () => {
    const g = grant({
      validUntil: T('2027-01-01T00:00:00.000Z'),
      revokedAt: T('2026-07-20T00:00:00.000Z'),
    });
    expect(isGrantActive(g, NOW)).toBe(false);
    expect(grantState(g, NOW)).toBe('revoked');
  });

  it('a revoked grant reads as revoked even when its window has also passed', () => {
    // The sweep's own output: expired window + revocation stamp. The explicit
    // act wins; revoke_reason='expired' records why.
    const g = grant({
      validUntil: T('2026-07-01T00:00:00.000Z'),
      revokedAt: T('2026-07-02T00:00:00.000Z'),
    });
    expect(grantState(g, NOW)).toBe('revoked');
    expect(isGrantActive(g, NOW)).toBe(false);
  });

  it('a grant revoked before it ever started reads as revoked, not pending', () => {
    const g = grant({
      validFrom: T('2026-09-01T00:00:00.000Z'),
      revokedAt: T('2026-07-10T00:00:00.000Z'),
    });
    expect(grantState(g, NOW)).toBe('revoked');
    expect(isGrantActive(g, NOW)).toBe(false);
  });

  it('is evaluated per instant — the same grant flips as time passes', () => {
    const g = grant({
      validFrom: T('2026-08-01T00:00:00.000Z'),
      validUntil: T('2026-09-01T00:00:00.000Z'),
    });
    expect(grantState(g, T('2026-07-15T00:00:00.000Z'))).toBe('pending');
    expect(grantState(g, T('2026-08-15T00:00:00.000Z'))).toBe('active');
    expect(grantState(g, T('2026-09-15T00:00:00.000Z'))).toBe('expired');
  });
});

describe('hasRole — exact module matching (Q5)', () => {
  const grants: Grant[] = [
    grant({ roleKey: 'hr_user', module: 'platform' }),
    grant({ roleKey: 'hr_user', module: 'hr.holiday_leave' }),
  ];

  it('admits a listed role in the exact module', () => {
    expect(hasRole(grants, ['hr_user'], 'platform', NOW)).toBe(true);
    expect(hasRole(grants, ['hr_user'], 'hr.holiday_leave', NOW)).toBe(true);
  });

  it('a platform grant does NOT satisfy a restricted HR module', () => {
    // The whole point of Q5: hr.er and hr.wellbeing are restricted areas
    // (SoW A5.5a/A5.5b) that a broad platform grant must not unlock.
    expect(hasRole(grants, ['hr_user'], 'hr.er', NOW)).toBe(false);
    expect(hasRole(grants, ['hr_user'], 'hr.wellbeing', NOW)).toBe(false);
  });

  it('a narrow HR grant does NOT satisfy a platform check', () => {
    const narrow = [grant({ roleKey: 'hr_user', module: 'hr.holiday_leave' })];
    expect(hasRole(narrow, ['hr_user'], 'platform', NOW)).toBe(false);
  });

  it('rejects an unlisted role even in the right module', () => {
    expect(hasRole(grants, ['administrator'], 'platform', NOW)).toBe(false);
  });

  it('admits when any one of several listed roles matches', () => {
    expect(hasRole(grants, ['administrator', 'hr_user'], 'platform', NOW)).toBe(true);
  });

  it('ignores a grant that is revoked or out of window', () => {
    const stale: Grant[] = [
      grant({ roleKey: 'administrator', module: 'platform', revokedAt: T('2026-07-01T00:00:00Z') }),
      grant({
        roleKey: 'director',
        module: 'platform',
        validUntil: T('2026-07-01T00:00:00.000Z'),
      }),
      grant({
        roleKey: 'finance',
        module: 'platform',
        validFrom: T('2026-12-01T00:00:00.000Z'),
      }),
    ];
    expect(hasRole(stale, ['administrator'], 'platform', NOW)).toBe(false);
    expect(hasRole(stale, ['director'], 'platform', NOW)).toBe(false);
    expect(hasRole(stale, ['finance'], 'platform', NOW)).toBe(false);
  });

  it('holding no grants authorises nothing', () => {
    expect(hasRole([], ['employee'], 'platform', NOW)).toBe(false);
  });
});

describe('activeModulesFor', () => {
  it('collects distinct modules where a listed role is active', () => {
    const grants: Grant[] = [
      grant({ roleKey: 'hr_user', module: 'platform' }),
      grant({ roleKey: 'hr_user', module: 'hr.core' }),
      grant({ roleKey: 'hr_user', module: 'hr.core' }), // duplicate module
      grant({ roleKey: 'employee', module: 'hr.er' }), // role not listed
      grant({ roleKey: 'hr_user', module: 'hr.ld', revokedAt: T('2026-07-01T00:00:00Z') }),
    ];
    expect(activeModulesFor(grants, ['hr_user'], NOW).sort()).toEqual(['hr.core', 'platform']);
  });
});
