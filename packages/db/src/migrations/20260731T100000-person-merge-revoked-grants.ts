import { Kysely, sql } from 'kysely';

/**
 * Core plan 03 §9.5 / PL-042, completed once plan 04's `role_grant` existed:
 * merging a person de-roles the superseded record, and unmerging restores what
 * the merge took away.
 *
 * `revoked_grant_ids` records exactly which grants the merge revoked, mirroring
 * `moved_user_ids` (the exact reversal set for repointed users). Unmerge reads
 * it rather than inferring the set from `revoke_reason` + timestamps, which
 * would misattribute a grant revoked manually in the same second.
 *
 * `person_merge` is append-only bar the one-time reversal stamp. Its guard
 * compares `to_jsonb(OLD)`/`to_jsonb(NEW)` minus the reversal columns, so a new
 * column is automatically covered: it is written at insert and any later change
 * to it is rejected. No guard change is needed.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // DEFAULT backfills the rows merged before de-roling existed — those merges
  // revoked nothing, so `[]` is the truthful value, not a placeholder.
  await sql`
    ALTER TABLE platform.person_merge
      ADD COLUMN revoked_grant_ids jsonb NOT NULL DEFAULT '[]'::jsonb
  `.execute(db);
  // Dropped again so every new merge states its set explicitly, exactly as
  // `moved_user_ids` does. A forgotten value then fails loudly.
  await sql`ALTER TABLE platform.person_merge ALTER COLUMN revoked_grant_ids DROP DEFAULT`.execute(
    db,
  );

  await sql`
    COMMENT ON COLUMN platform.person_merge.revoked_grant_ids IS
      'platform.role_grant ids revoked by this merge (PL-042). Unmerge re-grants them as NEW rows — grants are never un-revoked (core plan 04 §4.3).'
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE platform.person_merge DROP COLUMN IF EXISTS revoked_grant_ids`.execute(db);
}
