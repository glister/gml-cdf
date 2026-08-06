import { db, newUuidV7, type DomainEventRecord } from '@repo/db';
import { ROLE_KEYS, type RoleKey } from '@repo/domain';

/**
 * Shared fixtures for this package's real-Postgres suites.
 *
 * `truncateAll` wipes `platform.role`, which a migration seeds, so every suite
 * re-seeds it before granting anything — the same pattern the `@repo/trpc`
 * suites use.
 */

/** Deterministic ids so a re-seed is idempotent across suites. */
export async function reseedRoles(): Promise<void> {
  const existing = await db.selectFrom('platform.role').select('id').executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('platform.role')
    .values(
      ROLE_KEYS.map((key, i) => ({
        id: `019f509e-9e0${i.toString(16)}-7000-8000-00000000000${i.toString(16)}`,
        key,
        name: key,
      })),
    )
    .execute();
}

export async function insertPerson(displayName: string): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'employee', display_name: displayName })
    .execute();
  return id;
}

/**
 * Grant `role` in `module`, open-ended and long-standing.
 *
 * `validFrom` is deliberately far in the past: `roleProcedure` and the workflow
 * runtime both evaluate the grant window against the *transition's* `now`, and
 * suites pass fixed historical instants. A grant dated "an hour ago" in wall
 * time would silently fail those checks.
 */
export async function grant(
  personId: string,
  role: RoleKey,
  module = 'platform',
  validFrom = new Date('2020-01-01T00:00:00.000Z'),
): Promise<string> {
  const roleRow = await db
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', role)
    .executeTakeFirstOrThrow();
  const id = newUuidV7();
  await db
    .insertInto('platform.role_grant')
    .values({
      id,
      person_id: personId,
      role_id: roleRow.id,
      module: module as never,
      valid_from: validFrom,
      valid_until: null,
      created_by: personId,
      updated_by: personId,
    })
    .execute();
  return id;
}

/** Journal rows for a stream, oldest first — the assertion surface for events. */
export async function eventsFor(
  streamType: string,
  streamId: string,
): Promise<DomainEventRecord[]> {
  return db
    .selectFrom('platform.domain_event')
    .selectAll()
    .where('stream_type', '=', streamType)
    .where('stream_id', '=', streamId)
    .orderBy('recorded_at')
    .orderBy('id')
    .execute();
}
