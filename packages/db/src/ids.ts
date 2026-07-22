import { v7 as uuidV7 } from 'uuid';

/**
 * App-side UUIDv7 primary keys (ADR-0011). UUIDv7 is time-ordered, so IDs sort
 * lexicographically by creation time — index-friendly and safe to expose. We
 * generate them app-side (not via a DB default) so an ID exists before INSERT,
 * which lets correlated writes in a single transaction reference each other.
 *
 * `uuid`'s `v7()` carries a monotonic sub-millisecond sequence, so two IDs
 * minted within the same millisecond still order deterministically.
 *
 * DDL columns are plain `uuid` with **no** DB-side default — a missing ID must
 * fail loudly rather than be silently generated server-side.
 */
export function newUuidV7(): string {
  return uuidV7();
}
