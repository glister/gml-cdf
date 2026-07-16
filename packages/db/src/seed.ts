import { db, pool } from './client.js';
import { makeUser } from './test-support.js';

/**
 * Idempotent dev seed. Invoked via `pnpm seed`
 * (`tsx --env-file ../../.env src/seed.ts`). Standalone DB CLI — console logging.
 */
async function seed(): Promise<void> {
  const admin = makeUser({
    email: 'admin@cdf.local',
    name: 'Admin User',
    role: 'admin',
    email_verified: true,
  });

  await db
    .insertInto('user')
    .values(admin)
    .onConflict((oc) => oc.column('email').doNothing())
    .execute();

  // eslint-disable-next-line no-console
  console.log('✔ seed complete (admin@cdf.local)');

  await db.destroy();
  await pool.end().catch(() => {});
}

void seed();
