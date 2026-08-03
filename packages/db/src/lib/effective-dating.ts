import { sql, type Expression, type SqlBool, type Transaction } from 'kysely';
import type { DB } from '../types.js';

/**
 * Effective dating (core plan 05 §4.5, PL-007/PL-007a, ADR-0012) — the second
 * reusable versioning mechanism, and the one that answers **"which version
 * applied on date D?"**: bank-holiday calendars per year, working-pattern
 * assignments, team membership, config entries.
 *
 * Snapshot-on-use (`./snapshot.ts`) answers a different question and the two are
 * not alternatives. Tier 1 lookups need neither — an active flag plus journal
 * events is the whole mechanism there, and reaching for versioning on a Tier 1
 * list is the signal that the list is really Tier 2.
 *
 * Conventions every effective-dated table must follow (the helpers assume them):
 *
 *  - `valid_from date NOT NULL`, `valid_to date` (NULL = open-ended/current)
 *  - **half-open** `[valid_from, valid_to)` — a row with `valid_to = D` is NOT
 *    active on D, so a leaver and their replacement can share a boundary date
 *    without a gap or an overlap
 *  - `CHECK (valid_to IS NULL OR valid_to > valid_from)`
 *  - where "at most one version per key at a time" holds, a gist EXCLUDE
 *    constraint (see `team_membership_no_overlap`) — the invariant belongs in
 *    the database, not in a promise the application makes
 *
 * Day granularity is deliberate: leave, absence and calendar consumers reason in
 * business days, so `date` (not `timestamptz`) keeps boundary arithmetic exact.
 */

/**
 * WHERE expression selecting rows active on `asAt` — half-open, so
 * `valid_from <= asAt < valid_to`.
 *
 * `alias` is the table's alias or name in the query (e.g. `'m'`), interpolated
 * as an identifier; it is caller-supplied, never user input. `asAt` is a
 * `YYYY-MM-DD` date string — the same form `date` columns are read as
 * (`@repo/db`'s client pins the OID 1082 parser to raw strings), so no timezone
 * conversion sits between the value and the comparison.
 *
 * The plan's §4.5 sketch threaded an `ExpressionBuilder` through as a first
 * parameter; it is unused when the predicate is built from raw SQL, and an
 * unused parameter on a helper this widely copied is a defect that would be
 * copied too (deviation recorded in §4.5, 2026-08-03).
 */
export function activeOn(alias: string, asAt: string): Expression<SqlBool> {
  return sql<SqlBool>`${sql.ref(`${alias}.valid_from`)} <= ${asAt}::date
    AND (${sql.ref(`${alias}.valid_to`)} IS NULL
         OR ${sql.ref(`${alias}.valid_to`)} > ${asAt}::date)`;
}

/**
 * The effective-dated tables this helper may end a row in. A union rather than a
 * loose `string`: adding a table here is the one-line acknowledgement that it
 * has adopted the conventions above, and it keeps the Kysely update typed.
 * Later plans extend it (`hr.working_pattern_assignment`, `hr.register_membership`, …).
 * Members must carry a `person_id` column — the subject of the row is what the
 * caller journals, so it is returned here rather than re-read.
 */
export type EffectiveDatedTable = 'platform.team_membership';

export interface EndEffectiveInput {
  table: EffectiveDatedTable;
  id: string;
  /** `YYYY-MM-DD`. The row stops being active ON this date (half-open). */
  validTo: string;
  /** Stamped into `updated_by`. Effective-dated rows always have a human author. */
  actorPersonId: string;
}

/**
 * End-date a currently-open row.
 *
 * Refuses to touch a row that is already ended: re-ending would silently move a
 * boundary that other records have already been read against, which is exactly
 * the history rewrite effective dating exists to prevent. Correcting a date is a
 * separate, explicitly-journalled action (`correctMembership`).
 *
 * Runs inside the caller's transaction so the state change and its journal
 * event commit together (ADR-0010).
 */
export async function endEffective(
  trx: Transaction<DB>,
  input: EndEffectiveInput,
): Promise<{ personId: string; validFrom: string }> {
  const row = await trx
    .selectFrom(input.table)
    .select(['id', 'person_id', 'valid_from', 'valid_to'])
    .where('id', '=', input.id)
    .executeTakeFirst();
  if (!row) throw new Error(`effective-dated row ${input.id} not found in ${input.table}`);
  if (row.valid_to !== null) {
    throw new Error(`effective-dated row ${input.id} is already ended (valid_to=${row.valid_to})`);
  }
  if (input.validTo <= row.valid_from) {
    throw new Error(
      `valid_to ${input.validTo} must be after valid_from ${row.valid_from} for row ${input.id}`,
    );
  }

  await trx
    .updateTable(input.table)
    .set({ valid_to: input.validTo, updated_by: input.actorPersonId })
    .where('id', '=', input.id)
    .execute();

  return { personId: row.person_id, validFrom: row.valid_from };
}
