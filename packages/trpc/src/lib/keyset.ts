import { type Expression, type RawBuilder, sql, type SqlBool } from 'kysely';

/**
 * Keyset / cursor pagination helpers.
 *
 * The hard rule: all filtering/sorting/searching happens in SQL, and the SAME
 * sort-key expression drives both `ORDER BY` and the cursor boundary. Timestamp
 * sort keys are rendered as fixed-width text (via `timestampSortKey`) so
 * sub-second precision is not truncated at page edges, and every sort key is
 * coalesced to a non-null sentinel so the row-value comparison stays valid.
 */

export interface KeysetCursor {
  /** The fixed-width sort-key value of the boundary (last) row. */
  key: string;
  /** Tiebreaker id, for stable ordering across duplicate sort keys. */
  id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): KeysetCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as KeysetCursor).key === 'string' &&
      typeof (parsed as KeysetCursor).id === 'string'
    ) {
      return parsed as KeysetCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Render a timestamp column as fixed-width text (microsecond precision) so
 * keyset comparisons compare full precision. Coalesced to '' so the key is never
 * null (a null key would break the row-value boundary comparison).
 */
export function timestampSortKey(column: string): RawBuilder<string> {
  return sql<string>`coalesce(to_char(${sql.ref(column)}, 'YYYY-MM-DD"T"HH24:MI:SS.US'), '')`;
}

/**
 * The WHERE clause for the keyset boundary: a row-value comparison of
 * `(sortKey, id)` against the cursor. Uses the SAME `sortKey` expression as the
 * ORDER BY so the boundary is exact.
 */
export function keysetBoundary(
  sortKey: RawBuilder<string>,
  idColumn: string,
  cursor: KeysetCursor,
  direction: 'asc' | 'desc',
): Expression<SqlBool> {
  const op = direction === 'asc' ? sql`>` : sql`<`;
  return sql<SqlBool>`(${sortKey}, ${sql.ref(idColumn)}) ${op} (${cursor.key}, ${cursor.id})`;
}
