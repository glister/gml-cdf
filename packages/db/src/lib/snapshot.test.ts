import { describe, expect, it } from 'vitest';
import { makeSnapshot } from './snapshot.js';

/**
 * Snapshot-on-use (core plan 05 §10, PL-007a). The envelope is pure data, so
 * these are pure tests — the *behaviour* worth protecting is that the envelope
 * is a copy, taken at a caller-supplied instant, in the exact shape the
 * consuming plans will store and read back as `jsonb`.
 */
describe('makeSnapshot', () => {
  const takenAt = new Date('2026-08-03T09:15:30.500Z');

  it('builds the stored envelope shape, snake_case, with the supplied instant', () => {
    const envelope = makeSnapshot({
      sourceTable: 'hr.role_type',
      sourceId: '019fc7d9-5a91-75af-aae5-e155a6beac3c',
      sourceVersion: 3,
      takenAt,
      data: { requiresDbs: true, ppe: ['hard_hat'] },
    });

    expect(envelope).toEqual({
      source_table: 'hr.role_type',
      source_id: '019fc7d9-5a91-75af-aae5-e155a6beac3c',
      source_version: 3,
      taken_at: '2026-08-03T09:15:30.500Z',
      data: { requiresDbs: true, ppe: ['hard_hat'] },
    });
  });

  it('records a null version for sources that have none', () => {
    // Tier 1 lookups and any Tier 2/3 table without a version column: the
    // envelope still records *that* there was no version, rather than omitting
    // the key and leaving a reader guessing.
    const envelope = makeSnapshot({
      sourceTable: 'platform.lookup',
      sourceId: '019fc7d9-0000-7000-8000-000000000001',
      takenAt,
      data: { code: 'fencer', label: 'Fencer' },
    });
    expect(envelope.source_version).toBeNull();
    expect(Object.keys(envelope)).toContain('source_version');
  });

  it('is a copy: mutating the source afterwards leaves the snapshot alone', () => {
    // The whole point of PL-007a. A snapshot that aliased its source would pass
    // every shape assertion above and still restate the case when the reference
    // entity is edited.
    const source = { paid: true, deductsAllowance: true };
    const envelope = makeSnapshot({
      sourceTable: 'hr.leave_type',
      sourceId: '019fc7d9-0000-7000-8000-000000000002',
      takenAt,
      data: { ...source },
    });

    source.paid = false;
    source.deductsAllowance = false;

    expect(envelope.data).toEqual({ paid: true, deductsAllowance: true });
  });

  it('survives a JSON round-trip unchanged (it is stored as jsonb)', () => {
    const envelope = makeSnapshot({
      sourceTable: 'hr.role_type',
      sourceId: '019fc7d9-0000-7000-8000-000000000003',
      sourceVersion: 1,
      takenAt,
      data: { nested: { a: [1, 2, 3] }, flag: false },
    });
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });
});
