/**
 * Snapshot-on-use (core plan 05 §4.5, PL-007/PL-007a, ADR-0012) — one of the two
 * reusable versioning mechanisms every Tier 2/3 reference entity is built on.
 *
 * **The question it answers: "what rules governed *this* case?"** A long-lived
 * case (an onboarding case, a leave booking) consumes a reference entity's rules
 * at a point in time and must be judged by those rules forever. Editing the
 * source entity afterwards must not restate the case (ON-006, HL-002).
 *
 * The contract for consuming plans:
 *
 *  1. Store the envelope in a `jsonb` column on the consuming record (e.g.
 *     `hr.onboarding_case.role_type_snapshot`), written **in the same
 *     transaction** as the record's creation.
 *  2. Engines read the snapshot. They never re-join the live reference row for
 *     any decision about that case — a re-join is the bug this mechanism exists
 *     to prevent, and it is silent.
 *  3. Validate on read with `snapshotEnvelopeSchema(...)` from `@repo/trpc`.
 *
 * Effective dating is the *other* mechanism, not an alternative: use it when
 * readers ask "which version applied on date D?" for dates other than a case's
 * creation (see `./effective-dating.ts`). Tier 1 lookups need neither.
 *
 * Pure and clock-free — `takenAt` is passed in, never read from the process
 * clock, so a snapshot taken inside a transaction carries that transaction's
 * time (ADR-0009).
 */

export interface SnapshotEnvelope<T> {
  /** Schema-qualified source table, e.g. `'hr.role_type'`. */
  source_table: string;
  /** Primary key of the row snapshotted. */
  source_id: string;
  /** The source's version column, where it has one; `null` where it does not. */
  source_version: number | null;
  /** ISO timestamp the snapshot was taken. */
  taken_at: string;
  /** The frozen attribute payload, typed by the caller. */
  data: T;
}

export interface MakeSnapshotArgs<T> {
  sourceTable: string;
  sourceId: string;
  sourceVersion?: number;
  takenAt: Date;
  data: T;
}

/**
 * Build a snapshot envelope. Snake_case keys because the envelope is stored as
 * `jsonb` and read back by SQL as often as by TypeScript — matching the column
 * convention keeps `snapshot->>'source_id'` predicates readable.
 */
export function makeSnapshot<T>(args: MakeSnapshotArgs<T>): SnapshotEnvelope<T> {
  return {
    source_table: args.sourceTable,
    source_id: args.sourceId,
    source_version: args.sourceVersion ?? null,
    taken_at: args.takenAt.toISOString(),
    data: args.data,
  };
}
