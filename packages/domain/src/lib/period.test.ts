import { describe, expect, it } from 'vitest';
import { isWithinPeriod, overlaps } from './period.js';

const d = (iso: string): Date => new Date(iso);

describe('isWithinPeriod (half-open [from, to))', () => {
  const from = d('2026-01-01T00:00:00Z');
  const to = d('2026-02-01T00:00:00Z');

  it('includes the from boundary (inclusive)', () => {
    expect(isWithinPeriod(from, from, to)).toBe(true);
  });

  it('excludes the to boundary (exclusive)', () => {
    expect(isWithinPeriod(to, from, to)).toBe(false);
  });

  it('accepts an instant strictly inside', () => {
    expect(isWithinPeriod(d('2026-01-15T12:00:00Z'), from, to)).toBe(true);
  });

  it('rejects an instant before from', () => {
    expect(isWithinPeriod(d('2025-12-31T23:59:59Z'), from, to)).toBe(false);
  });

  it('treats to = null as open-ended', () => {
    expect(isWithinPeriod(d('2099-01-01T00:00:00Z'), from, null)).toBe(true);
    expect(isWithinPeriod(d('2025-01-01T00:00:00Z'), from, null)).toBe(false);
  });

  it('adversarial: zero-length period contains nothing (from == to)', () => {
    // [x, x) is empty; even the boundary itself is excluded.
    expect(isWithinPeriod(from, from, from)).toBe(false);
  });
});

describe('overlaps (half-open intervals)', () => {
  it('adjacent periods touching at a boundary do NOT overlap', () => {
    const a = { from: d('2026-01-01T00:00:00Z'), to: d('2026-02-01T00:00:00Z') };
    const b = { from: d('2026-02-01T00:00:00Z'), to: d('2026-03-01T00:00:00Z') };
    expect(overlaps(a.from, a.to, b.from, b.to)).toBe(false);
  });

  it('genuinely overlapping periods overlap', () => {
    const a = { from: d('2026-01-01T00:00:00Z'), to: d('2026-02-15T00:00:00Z') };
    const b = { from: d('2026-02-01T00:00:00Z'), to: d('2026-03-01T00:00:00Z') };
    expect(overlaps(a.from, a.to, b.from, b.to)).toBe(true);
  });

  it('disjoint periods do not overlap', () => {
    const a = { from: d('2026-01-01T00:00:00Z'), to: d('2026-02-01T00:00:00Z') };
    const b = { from: d('2026-03-01T00:00:00Z'), to: d('2026-04-01T00:00:00Z') };
    expect(overlaps(a.from, a.to, b.from, b.to)).toBe(false);
  });

  it('two open-ended periods always overlap', () => {
    const from = d('2026-01-01T00:00:00Z');
    expect(overlaps(from, null, d('2030-01-01T00:00:00Z'), null)).toBe(true);
  });

  it('an open-ended period overlaps a later bounded one it reaches', () => {
    expect(
      overlaps(
        d('2026-01-01T00:00:00Z'),
        null,
        d('2027-01-01T00:00:00Z'),
        d('2027-02-01T00:00:00Z'),
      ),
    ).toBe(true);
  });

  it('is symmetric', () => {
    const a = { from: d('2026-01-01T00:00:00Z'), to: d('2026-02-15T00:00:00Z') };
    const b = { from: d('2026-02-01T00:00:00Z'), to: null };
    expect(overlaps(a.from, a.to, b.from, b.to)).toBe(overlaps(b.from, b.to, a.from, a.to));
  });
});
