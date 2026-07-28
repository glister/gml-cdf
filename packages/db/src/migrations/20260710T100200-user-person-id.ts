import { Kysely, sql } from 'kysely';

/**
 * Core plan 03 (ADR-0014): the ONE column we add to a Better Auth framework
 * table — `user.person_id`, the link from an authentication identity to its
 * durable `platform.person`. Declared to Better Auth as an additional field
 * (`input: false`) so the framework round-trips it but no client can set it.
 *
 * Nullable for now: existing dev users are backfilled by task 9.3-3, after
 * which a follow-up migration sets it NOT NULL (task 9.1-6). We never repoint
 * `account`/`session` rows — merge touches only this column.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('user')
    .addColumn('person_id', 'uuid', (c) => c.references('platform.person.id'))
    .execute();
  await sql`CREATE INDEX user_person_id_idx ON "user" (person_id)`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS user_person_id_idx`.execute(db);
  await db.schema.alterTable('user').dropColumn('person_id').execute();
}
