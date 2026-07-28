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
/**
 * Grant `administrator` in every module (core plan 04). There is no implicit
 * superuser and no wildcard module (Q5), so an Administrator needs one grant per
 * module — that is the price of every access decision being explainable from
 * `role_grant` rows. Idempotent: the partial unique index permits one live grant
 * per (person, role, module), so re-running the seed inserts nothing new.
 */
async function grantAdministratorEverywhere(personId: string): Promise<void> {
  const role = await db
    .selectFrom('platform.role')
    .select('id')
    .where('key', '=', 'administrator')
    .executeTakeFirst();
  if (!role) {
    // eslint-disable-next-line no-console
    console.warn('! seed: administrator role missing — run migrations first');
    return;
  }
  const modules = [
    'platform',
    'hr.core',
    'hr.onboarding',
    'hr.holiday_leave',
    'hr.sickness_absence',
    'hr.er',
    'hr.ld',
    'hr.offboarding',
    'hr.wellbeing',
    'hr.reporting',
  ] as const;

  for (const module of modules) {
    await db
      .insertInto('platform.role_grant')
      .values({
        id: newUuidV7(),
        person_id: personId,
        role_id: role.id,
        module,
        created_by: personId,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  // eslint-disable-next-line no-console
  console.log(`✔ seed: administrator granted in ${modules.length} modules`);
}

async function seed(): Promise<void> {
  const email = 'admin@cdf.local';

  const existing = await db
    .selectFrom('user')
    .select(['id', 'person_id'])
    .where('email', '=', email)
    .executeTakeFirst();

  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`✔ seed: ${email} already present`);
    // Backfill grants for a database seeded before core plan 04 — without them
    // the admin can authenticate but reaches no product surface.
    if (existing.person_id) await grantAdministratorEverywhere(existing.person_id);
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
    await grantAdministratorEverywhere(personId);

    // eslint-disable-next-line no-console
    console.log(`✔ seed complete (${email}, person ${personId})`);
  }

  await db.destroy();
  await pool.end().catch(() => {});
}

void seed();
