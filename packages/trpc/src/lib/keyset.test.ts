import { describe, expect, it } from 'vitest';
import { db } from '@repo/db';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from './keyset.js';

describe('cursor encode/decode', () => {
  it('roundtrips a cursor', () => {
    const cursor = { key: '2026-01-01T00:00:00.000000', id: 'abc-123' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('returns null on malformed input', () => {
    expect(decodeCursor('%%%not-base64%%%')).toBeNull();
    // valid base64 but missing required fields
    expect(decodeCursor(Buffer.from('{}').toString('base64url'))).toBeNull();
  });
});

// Compiles the query offline (no DB connection needed) to assert the SQL shape.
describe('keyset SQL generation', () => {
  it('renders a fixed-width sort key and a row-value boundary', () => {
    const sortKey = timestampSortKey('u.created_at');
    const compiled = db
      .selectFrom('user as u')
      .select(['u.id'])
      .select(sortKey.as('sort_key'))
      .where(keysetBoundary(sortKey, 'u.id', { key: 'K', id: 'ID' }, 'desc'))
      .orderBy(sortKey, 'desc')
      .orderBy('u.id', 'desc')
      .limit(21)
      .compile();

    // fixed-width text rendering of the timestamp
    expect(compiled.sql).toContain('to_char');
    expect(compiled.sql).toContain('coalesce');
    // desc boundary uses `<`
    expect(compiled.sql).toContain('<');
    // cursor values are bound as parameters (not interpolated)
    expect(compiled.parameters).toContain('K');
    expect(compiled.parameters).toContain('ID');
  });

  it('uses `>` for ascending order', () => {
    const sortKey = timestampSortKey('u.created_at');
    const compiled = db
      .selectFrom('user as u')
      .select(['u.id'])
      .where(keysetBoundary(sortKey, 'u.id', { key: 'K', id: 'ID' }, 'asc'))
      .compile();
    expect(compiled.sql).toContain('>');
  });
});
