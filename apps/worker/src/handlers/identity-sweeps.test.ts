import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type NewPerson, db, newUuidV7 } from '@repo/db';
import { createMigrator, makeUser, truncateAll } from '@repo/db/test-support';
import type { Logger } from 'winston';
import { runAccessExpirySweep } from './identity-access-expiry.js';
import { runDuplicateScan } from './identity-duplicate-scan.js';
import type { HandlerContext } from '../types.js';

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await truncateAll(db);
});

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const ctx: HandlerContext = { db, logger };

async function insertPerson(overrides: Partial<NewPerson> = {}): Promise<string> {
  const id = overrides.id ?? newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'agency', display_name: 'P', ...overrides })
    .execute();
  return id;
}

/**
 * Seed one live grant. The sweep must de-role as well as disable — ON AC-9 says
 * "automatically disabled **and de-roled**", and the two halves are one
 * transaction in the handler.
 */
async function insertGrant(personId: string): Promise<string> {
  const roleId = newUuidV7();
  await db
    .insertInto('platform.role')
    .values({ id: roleId, key: 'external', name: 'External' })
    .execute();
  const grantId = newUuidV7();
  await db
    .insertInto('platform.role_grant')
    .values({
      id: grantId,
      person_id: personId,
      role_id: roleId,
      module: 'platform',
      created_by: personId,
    })
    .execute();
  return grantId;
}

async function eventCount(personId: string, eventType: string): Promise<number> {
  const rows = await db
    .selectFrom('platform.domain_event')
    .select('id')
    .where('stream_id', '=', personId)
    .where('event_type', '=', eventType)
    .execute();
  return rows.length;
}

describe('runAccessExpirySweep (PL-042, ON AC-9)', () => {
  it('disables an expired external, journals once, and is idempotent', async () => {
    const past = new Date(Date.now() - 86_400_000);
    const expired = await insertPerson({ status: 'active', access_valid_until: past });
    const future = await insertPerson({
      status: 'active',
      access_valid_until: new Date(Date.now() + 86_400_000),
    });
    const user = makeUser({ person_id: expired });
    await db.insertInto('user').values(user).execute();

    await runAccessExpirySweep(ctx);

    const row = await db
      .selectFrom('platform.person')
      .select('status')
      .where('id', '=', expired)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('inactive');
    const banned = await db
      .selectFrom('user')
      .select('banned')
      .where('id', '=', user.id as string)
      .executeTakeFirstOrThrow();
    expect(banned.banned).toBe(true);
    expect(await eventCount(expired, 'platform.person.access_expired')).toBe(1);
    // The not-yet-expired person is untouched.
    const stillActive = await db
      .selectFrom('platform.person')
      .select('status')
      .where('id', '=', future)
      .executeTakeFirstOrThrow();
    expect(stillActive.status).toBe('active');

    // Re-running the sweep produces no second event.
    await runAccessExpirySweep(ctx);
    expect(await eventCount(expired, 'platform.person.access_expired')).toBe(1);
  });

  it('de-roles the expired person through the shared revoke path (ADR-0022)', async () => {
    const expired = await insertPerson({
      status: 'active',
      access_valid_until: new Date(Date.now() - 86_400_000),
    });
    await db
      .insertInto('user')
      .values(makeUser({ person_id: expired }))
      .execute();
    const grantId = await insertGrant(expired);

    await runAccessExpirySweep(ctx);

    const grant = await db
      .selectFrom('platform.role_grant')
      .select(['revoked_at', 'revoke_reason', 'revoked_by'])
      .where('id', '=', grantId)
      .executeTakeFirstOrThrow();
    expect(grant.revoked_at).not.toBeNull();
    expect(grant.revoke_reason).toBe('expired');
    // NULL actor = the system did it, per the repo-wide convention.
    expect(grant.revoked_by).toBeNull();
    const revocations = await db
      .selectFrom('platform.domain_event')
      .select('id')
      .where('stream_id', '=', grantId)
      .where('event_type', '=', 'platform.role.revoked')
      .execute();
    expect(revocations).toHaveLength(1);

    // Idempotent: a redelivered sweep message must not journal a second time.
    await runAccessExpirySweep(ctx);
    expect(
      await db
        .selectFrom('platform.domain_event')
        .select('id')
        .where('stream_id', '=', grantId)
        .where('event_type', '=', 'platform.role.revoked')
        .execute(),
    ).toHaveLength(1);
  });
});

describe('runDuplicateScan (PL-037)', () => {
  it('flags a strong match once and does not re-flag on a second run', async () => {
    const a = await insertPerson({
      given_name: 'Sam',
      family_name: 'Jones',
      date_of_birth: '1980-03-03',
    });
    const b = await insertPerson({
      given_name: 'sam',
      family_name: 'JONES',
      date_of_birth: '1980-03-03',
    });
    const [min] = [a, b].sort();

    await runDuplicateScan(ctx);
    expect(await eventCount(min, 'platform.person.duplicate_flagged')).toBe(1);

    await runDuplicateScan(ctx);
    expect(await eventCount(min, 'platform.person.duplicate_flagged')).toBe(1); // anti-join holds
  });

  it('does not flag two persons who do not match', async () => {
    const a = await insertPerson({
      given_name: 'Ann',
      family_name: 'A',
      date_of_birth: '1990-01-01',
    });
    await insertPerson({ given_name: 'Bob', family_name: 'B', date_of_birth: '1991-02-02' });
    await runDuplicateScan(ctx);
    expect(await eventCount(a, 'platform.person.duplicate_flagged')).toBe(0);
  });
});
