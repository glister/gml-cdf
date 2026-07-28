import { describe, expect, it } from 'vitest';
import { matchDuplicate, normaliseIdentityValue } from './duplicate-match.js';

describe('normaliseIdentityValue', () => {
  it('case- and whitespace-folds, and treats absent/blank as null', () => {
    expect(normaliseIdentityValue('  Smith  ')).toBe('smith');
    expect(normaliseIdentityValue('Van  der   Berg')).toBe('van der berg');
    expect(normaliseIdentityValue(null)).toBeNull();
    expect(normaliseIdentityValue(undefined)).toBeNull();
    expect(normaliseIdentityValue('   ')).toBeNull();
  });

  it('folds composed vs decomposed unicode to the same value (NFKC)', () => {
    // "é" as a single codepoint vs "e" + combining acute.
    expect(normaliseIdentityValue('Renée')).toBe(normaliseIdentityValue('Renée'));
  });

  it('does NOT strip diacritics — "José" and "Jose" stay distinct', () => {
    expect(normaliseIdentityValue('José')).not.toBe(normaliseIdentityValue('Jose'));
  });
});

describe('matchDuplicate', () => {
  const base = {
    givenName: 'Jane',
    familyName: 'Smith',
    dateOfBirth: '1990-01-02',
    agencyWorkerReference: 'AG-1',
  };

  it('matches on name + DoB across case and whitespace', () => {
    const r = matchDuplicate(base, {
      givenName: ' jane ',
      familyName: 'SMITH',
      dateOfBirth: '1990-01-02',
      agencyWorkerReference: null,
    });
    expect(r.match).toBe(true);
    expect(r.reasons).toContain('name_dob');
    expect(r.reasons).not.toContain('agency_ref');
  });

  it('matches on agency reference alone (different name)', () => {
    const r = matchDuplicate(base, {
      givenName: 'Other',
      familyName: 'Person',
      dateOfBirth: '1975-12-31',
      agencyWorkerReference: 'ag-1',
    });
    expect(r.match).toBe(true);
    expect(r.reasons).toEqual(['agency_ref']);
  });

  it('reports both reasons when both match', () => {
    const r = matchDuplicate(base, base);
    expect(r.reasons.sort()).toEqual(['agency_ref', 'name_dob']);
  });

  it('does not match same name but different DoB', () => {
    const r = matchDuplicate(base, {
      ...base,
      dateOfBirth: '1991-01-02',
      agencyWorkerReference: null,
    });
    expect(r.match).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('does not match when given name is missing on one side', () => {
    const r = matchDuplicate(
      { ...base, agencyWorkerReference: null },
      { ...base, givenName: null, agencyWorkerReference: null },
    );
    expect(r.reasons).not.toContain('name_dob');
  });

  it('does not treat two absent DoBs as a match', () => {
    const a = {
      givenName: 'Jane',
      familyName: 'Smith',
      dateOfBirth: null,
      agencyWorkerReference: null,
    };
    expect(matchDuplicate(a, a).match).toBe(false);
  });

  it('does not treat two blank agency refs as a match', () => {
    const a = { givenName: null, familyName: null, dateOfBirth: null, agencyWorkerReference: '  ' };
    expect(matchDuplicate(a, a).match).toBe(false);
  });
});
