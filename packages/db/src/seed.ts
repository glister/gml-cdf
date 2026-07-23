import { db, pool } from './client.js';
import { newUuidV7 } from './ids.js';
import { makeUser } from './test-support.js';

/**
 * Idempotent dev seed. Invoked via `pnpm seed`
 * (`tsx --env-file ../../.env src/seed.ts`). Standalone DB CLI — console logging.
 *
 * Seeds one admin as a complete identity (core plan 03): a `platform.person`
 * (employee) with a linked Better Auth user carrying `person_id`. Password auth
 * is removed, so the admin signs in via email-OTP (Mailpit in dev) as the
 * break-glass administrator.
 */
async function seed(): Promise<void> {
  const email = 'admin@cdf.local';

  const existing = await db
    .selectFrom('user')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();

  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`✔ seed: ${email} already present`);
  } else {
    const personId = newUuidV7();
    await db
      .insertInto('platform.person')
      .values({
        id: personId,
        relationship_type: 'employee',
        profile_status: 'active',
        display_name: 'Admin User',
        given_name: 'Admin',
        family_name: 'User',
        contact_email: email,
      })
      .execute();

    const admin = makeUser({
      email,
      name: 'Admin User',
      role: 'admin',
      email_verified: true,
      person_id: personId,
    });
    await db.insertInto('user').values(admin).execute();

    // eslint-disable-next-line no-console
    console.log(`✔ seed complete (${email}, person ${personId})`);
  }

  await db.destroy();
  await pool.end().catch(() => {});
}

void seed();
