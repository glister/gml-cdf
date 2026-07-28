import { db, pool } from './client.js';
import { newUuidV7 } from './ids.js';

/**
 * One-off backfill (core plan 03, task 9.3-3): attach every existing Better Auth
 * user that predates the person model to a `platform.person`. For each user
 * lacking `person_id`, create an employee at `draft_shell` (an unmatched legacy
 * account, not operationally live — activation is an explicit transition) and
 * link it. Idempotent — users already linked are skipped.
 *
 * Standalone DB CLI (console logging), run via
 * `tsx --env-file ../../.env src/backfill-persons.ts`. `user.person_id` stays
 * nullable (the Entra hook attaches after Better Auth inserts the user), so this
 * is a data hygiene step, not a precondition for a NOT NULL constraint.
 */
async function backfill(): Promise<void> {
  const orphans = await db
    .selectFrom('user')
    .select(['id', 'email', 'name'])
    .where('person_id', 'is', null)
    .execute();

  let linked = 0;
  for (const user of orphans) {
    await db.transaction().execute(async (trx) => {
      const personId = newUuidV7();
      await trx
        .insertInto('platform.person')
        .values({
          id: personId,
          relationship_type: 'employee',
          profile_status: 'draft_shell',
          display_name: user.name || user.email,
          contact_email: user.email.toLowerCase(),
        })
        .execute();
      await trx
        .updateTable('user')
        .set({ person_id: personId })
        .where('id', '=', user.id)
        .execute();
    });
    linked += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`✔ backfill complete: linked ${linked} user(s) to a person`);

  await db.destroy();
  await pool.end().catch(() => {});
}

void backfill();
