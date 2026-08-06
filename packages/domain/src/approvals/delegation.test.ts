import { describe, expect, it } from 'vitest';
import {
  activeDelegations,
  assertDelegationValid,
  isDelegationActive,
  DelegationWindowError,
  type DelegationWindow,
} from './delegation.js';

/**
 * Delegation windows (core plan 09 §9.2, AC-D3).
 *
 * Every instant here is written out rather than derived from a clock — the
 * package reads no clock (ADR-0009), and the boundary cases are the whole point
 * of the suite.
 */

const ALICE = '0192f3a4-0000-7000-8000-00000000a11c';
const BOB = '0192f3a4-0000-7000-8000-00000000b0b0';

const FROM = new Date('2026-08-10T00:00:00.000Z');
const TO = new Date('2026-08-20T00:00:00.000Z');

function delegation(over: Partial<DelegationWindow> = {}): DelegationWindow {
  return {
    id: 'd1',
    delegatorPersonId: ALICE,
    delegatePersonId: BOB,
    subjectType: null,
    validFrom: FROM,
    validTo: TO,
    revokedAt: null,
    ...over,
  };
}

const scope = { at: new Date('2026-08-15T12:00:00.000Z'), subjectType: 'hr.leave_booking' };

describe('isDelegationActive — window edges', () => {
  it('is active inside the window', () => {
    expect(isDelegationActive(delegation(), scope)).toBe(true);
  });

  it('is not active before it starts', () => {
    expect(
      isDelegationActive(delegation(), { ...scope, at: new Date('2026-08-09T23:59:59.999Z') }),
    ).toBe(false);
  });

  /** Half-open `[from, to)`: the first instant counts. */
  it('is active at the opening instant', () => {
    expect(isDelegationActive(delegation(), { ...scope, at: FROM })).toBe(true);
  });

  /**
   * …and the closing instant does not. This is what stops two consecutive
   * delegations both applying during the hand-over minute.
   */
  it('is not active at the closing instant', () => {
    expect(isDelegationActive(delegation(), { ...scope, at: TO })).toBe(false);
  });

  it('is not active after it ends', () => {
    expect(
      isDelegationActive(delegation(), { ...scope, at: new Date('2026-09-01T00:00:00.000Z') }),
    ).toBe(false);
  });
});

describe('isDelegationActive — revocation', () => {
  const revoked = delegation({ revokedAt: new Date('2026-08-15T09:00:00.000Z') });

  it('is not active from the revocation instant onwards', () => {
    expect(isDelegationActive(revoked, scope)).toBe(false);
  });

  /**
   * The decision taken at 08:00 was authorised, and stays authorised when the
   * journal is re-read. Revocation ends a window; it does not unmake the past.
   */
  it('was active before the revocation', () => {
    expect(
      isDelegationActive(revoked, { ...scope, at: new Date('2026-08-15T08:00:00.000Z') }),
    ).toBe(true);
  });
});

describe('isDelegationActive — subject scoping', () => {
  it('an unscoped delegation covers every subject type', () => {
    expect(isDelegationActive(delegation({ subjectType: null }), scope)).toBe(true);
  });

  it('a scoped delegation covers its own subject type', () => {
    expect(isDelegationActive(delegation({ subjectType: 'hr.leave_booking' }), scope)).toBe(true);
  });

  it('a scoped delegation covers nothing else', () => {
    expect(isDelegationActive(delegation({ subjectType: 'hr.toil_claim' }), scope)).toBe(false);
  });
});

describe('activeDelegations', () => {
  it('narrows to those in force and drops the window detail', () => {
    const result = activeDelegations(
      [
        delegation({ id: 'in' }),
        delegation({ id: 'expired', validTo: new Date('2026-08-11T00:00:00.000Z') }),
        delegation({ id: 'scoped-out', subjectType: 'hr.toil_claim' }),
        delegation({ id: 'revoked', revokedAt: new Date('2026-08-12T00:00:00.000Z') }),
      ],
      scope,
    );

    expect(result).toEqual([{ id: 'in', delegatorPersonId: ALICE, delegatePersonId: BOB }]);
  });

  it('returns nothing from an empty set', () => {
    expect(activeDelegations([], scope)).toEqual([]);
  });
});

describe('assertDelegationValid', () => {
  const proposal = {
    delegatorPersonId: ALICE,
    delegatePersonId: BOB,
    validFrom: FROM,
    validTo: TO,
  };

  it('accepts a delegation inside the configured ceiling', () => {
    expect(() => assertDelegationValid(proposal, { maxDurationDays: 90 })).not.toThrow();
  });

  it('refuses a self-delegation', () => {
    expect(() =>
      assertDelegationValid({ ...proposal, delegatePersonId: ALICE }, { maxDurationDays: 90 }),
    ).toThrow(DelegationWindowError);
  });

  it('refuses a window that ends before it starts', () => {
    expect(() =>
      assertDelegationValid({ ...proposal, validTo: FROM }, { maxDurationDays: 90 }),
    ).toThrow(/end after it starts/);
  });

  /** The ceiling is configuration, so the same window passes or fails by policy. */
  it('refuses a window longer than the ceiling, and accepts it when the ceiling moves', () => {
    expect(() => assertDelegationValid(proposal, { maxDurationDays: 5 })).toThrow(
      /more than 5 days/,
    );
    expect(() => assertDelegationValid(proposal, { maxDurationDays: 10 })).not.toThrow();
  });
});
