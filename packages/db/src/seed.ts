import { db, pool } from './client.js';
import { newUuidV7 } from './ids.js';
import type { NewLookup } from './index.js';
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

/**
 * Grant the operational roles the pilot task list assigns to (core plan 08 §9.6).
 *
 * The pilot checklist assigns to `it` and `transport` — never to a person — so
 * without these grants the seeded admin sees an empty my-tasks list and would
 * reasonably conclude the engine is broken. Granting them here is also the
 * clearest demonstration of the model: the tasks exist either way, and it is the
 * *grant* that decides whose list they appear on (PL-014, ON AC-5).
 */
async function grantPilotOperationalRoles(personId: string): Promise<void> {
  const roles = await db
    .selectFrom('platform.role')
    .select(['id', 'key'])
    .where('key', 'in', ['it', 'transport'])
    .execute();
  if (roles.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('! seed: operational roles missing — run migrations first');
    return;
  }
  for (const role of roles) {
    await db
      .insertInto('platform.role_grant')
      .values({
        id: newUuidV7(),
        person_id: personId,
        role_id: role.id,
        module: 'platform',
        created_by: personId,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  // eslint-disable-next-line no-console
  console.log(`✔ seed: pilot operational roles granted (${roles.map((r) => r.key).join(', ')})`);
}

/**
 * Dev placeholders for the seven Phase 1 Tier 1 lists (core plan 05 §9.1).
 * Production values come from the config workshops and the Breathe HR export.
 *
 * **The `code`s below are the migration contract (DM-002).** Breathe mapping
 * tables target `(list_type, code)`, so a code here is renamed only alongside
 * its mapping — labels are the freely editable half of the pair (§4.1.1).
 */
type SeedListType = NewLookup['list_type'];

const SEED_LOOKUPS: ReadonlyArray<{ listType: SeedListType; code: string; label: string }> = [
  { listType: 'department', code: 'fencing_ops', label: 'Fencing Operations' },
  { listType: 'department', code: 'transport', label: 'Transport' },
  { listType: 'department', code: 'office', label: 'Office' },
  { listType: 'department', code: 'finance', label: 'Finance' },

  { listType: 'job_role', code: 'fencer', label: 'Fencer' },
  { listType: 'job_role', code: 'fencing_mate', label: 'Fencing Mate' },
  { listType: 'job_role', code: 'site_supervisor', label: 'Site Supervisor' },
  { listType: 'job_role', code: 'driver', label: 'Driver' },
  { listType: 'job_role', code: 'office_administrator', label: 'Office Administrator' },

  { listType: 'document_category', code: 'contract', label: 'Contract' },
  { listType: 'document_category', code: 'right_to_work', label: 'Right to Work' },
  { listType: 'document_category', code: 'qualification', label: 'Qualification / Card' },
  { listType: 'document_category', code: 'policy', label: 'Policy' },
  { listType: 'document_category', code: 'id_document', label: 'Identity Document' },
  // Added by core plan 11 (§4.4): the document engine issues correspondence that
  // is none of the five above, and `offer_letter` is the category the onboarding
  // plan's first template pack needs. `other` is the honest home for the pilot's
  // welcome letter — better a category that says "uncategorised" than one that
  // claims a welcome letter is a contract.
  { listType: 'document_category', code: 'offer_letter', label: 'Offer Letter' },
  { listType: 'document_category', code: 'other', label: 'Other' },

  // SA-001's sickness categories. The *list* is public reference data; a
  // person's sickness *records* are the HR module's special-category concern.
  { listType: 'sickness_type', code: 'cold_flu', label: 'Cold / Flu' },
  { listType: 'sickness_type', code: 'stomach', label: 'Stomach / Digestive' },
  { listType: 'sickness_type', code: 'musculoskeletal', label: 'Musculoskeletal' },
  { listType: 'sickness_type', code: 'stress_anxiety', label: 'Stress / Anxiety' },
  { listType: 'sickness_type', code: 'other', label: 'Other' },

  { listType: 'ppe_type', code: 'hard_hat', label: 'Hard Hat' },
  { listType: 'ppe_type', code: 'hi_vis', label: 'Hi-Vis Vest' },
  { listType: 'ppe_type', code: 'safety_boots', label: 'Safety Boots' },
  { listType: 'ppe_type', code: 'gloves', label: 'Gloves' },
  { listType: 'ppe_type', code: 'ear_defenders', label: 'Ear Defenders' },

  { listType: 'leaver_reason', code: 'resignation', label: 'Resignation' },
  { listType: 'leaver_reason', code: 'end_of_contract', label: 'End of Contract' },
  { listType: 'leaver_reason', code: 'redundancy', label: 'Redundancy' },
  { listType: 'leaver_reason', code: 'dismissal', label: 'Dismissal' },
  { listType: 'leaver_reason', code: 'retirement', label: 'Retirement' },

  { listType: 'equipment_type', code: 'mobile_phone', label: 'Mobile Phone' },
  { listType: 'equipment_type', code: 'laptop', label: 'Laptop' },
  { listType: 'equipment_type', code: 'van', label: 'Van' },
  { listType: 'equipment_type', code: 'power_tools', label: 'Power Tools' },
  { listType: 'equipment_type', code: 'fuel_card', label: 'Fuel Card' },
];

/**
 * Seed the Tier 1 lists and one demo team (core plan 05). Idempotent via the
 * `(list_type, code)` and live-name unique constraints, so re-running adds
 * nothing. `sort_order` follows declaration order within each list.
 */
async function seedReferenceData(actorPersonId: string): Promise<void> {
  const orderByList = new Map<string, number>();
  const rows = SEED_LOOKUPS.map((v) => {
    const next = orderByList.get(v.listType) ?? 0;
    orderByList.set(v.listType, next + 1);
    return {
      id: newUuidV7(),
      list_type: v.listType,
      code: v.code,
      label: v.label,
      sort_order: next,
      created_by: actorPersonId,
      updated_by: actorPersonId,
    };
  });
  await db
    .insertInto('platform.lookup')
    .values(rows)
    .onConflict((oc) => oc.columns(['list_type', 'code']).doNothing())
    .execute();
  // eslint-disable-next-line no-console
  console.log(`✔ seed: ${rows.length} lookup values across ${orderByList.size} list types`);

  const team = await db
    .selectFrom('platform.team')
    .select('id')
    .where('name', '=', 'Fencing Crew A')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (team) {
    // eslint-disable-next-line no-console
    console.log('✔ seed: demo team already present');
    return;
  }
  const teamId = newUuidV7();
  await db
    .insertInto('platform.team')
    .values({
      id: teamId,
      name: 'Fencing Crew A',
      description: 'Demo team for core plan 05 (PL-005d/e).',
      manager_person_id: actorPersonId,
      max_concurrent_leave: 2,
      colour: '#2f6f4f',
      created_by: actorPersonId,
      updated_by: actorPersonId,
    })
    .execute();
  await db
    .insertInto('platform.team_membership')
    .values({
      id: newUuidV7(),
      team_id: teamId,
      person_id: actorPersonId,
      // Open-ended (`valid_to` NULL) = current member.
      valid_from: '2026-01-01',
      created_by: actorPersonId,
      updated_by: actorPersonId,
    })
    .execute();
  // eslint-disable-next-line no-console
  console.log(`✔ seed: demo team ${teamId} with one open-ended membership`);
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
    if (existing.person_id) {
      await grantAdministratorEverywhere(existing.person_id);
      await grantPilotOperationalRoles(existing.person_id);
      await seedReferenceData(existing.person_id);
    }
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
    await grantPilotOperationalRoles(personId);
    await seedReferenceData(personId);

    // eslint-disable-next-line no-console
    console.log(`✔ seed complete (${email}, person ${personId})`);
  }

  await db.destroy();
  await pool.end().catch(() => {});
}

void seed();
