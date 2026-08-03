import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../client.js';
import { newUuidV7 } from '../ids.js';
import { createMigrator, truncateAll } from '../test-support.js';
import { activeOn, endEffective } from './effective-dating.js';

/**
 * Effective dating (core plan 05 §10, PL-007/PL-007a). Real Postgres, because
 * the thing under test is a SQL predicate and a `date`-column boundary — a mock
 * would prove the TypeScript compiles, not that the half-open interval is
 * half-open (ADR-0004).
 *
 * `platform.team_membership` is the exemplar table; every later effective-dated
 * table inherits these semantics, so a regression here is a regression
 * everywhere.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let personId: string;
let otherPersonId: string;
let teamId: string;

beforeEach(async () => {
  await truncateAll(db);
  personId = await insertPerson();
  otherPersonId = await insertPerson();
  teamId = newUuidV7();
  await db
    .insertInto('platform.team')
    .values({
      id: teamId,
      name: 'Effective dating fixture',
      manager_person_id: personId,
      created_by: personId,
      updated_by: personId,
    })
    .execute();
});

async function insertPerson(): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'agency', display_name: 'Person' })
    .execute();
  return id;
}

async function insertMembership(window: {
  validFrom: string;
  validTo?: string | null;
  person?: string;
}): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.team_membership')
    .values({
      id,
      team_id: teamId,
      person_id: window.person ?? personId,
      valid_from: window.validFrom,
      valid_to: window.validTo ?? null,
      created_by: personId,
      updated_by: personId,
    })
    .execute();
  return id;
}

/** Ids of memberships this helper considers active on `asAt`. */
async function activeIdsOn(asAt: string): Promise<string[]> {
  const rows = await db
    .selectFrom('platform.team_membership as m')
    .select('m.id')
    .where(activeOn('m', asAt))
    .orderBy('m.valid_from')
    .execute();
  return rows.map((r) => r.id);
}

describe('activeOn (half-open [valid_from, valid_to))', () => {
  it('includes the start date and excludes the end date', async () => {
    const id = await insertMembership({ validFrom: '2026-03-01', validTo: '2026-06-01' });

    // The boundary pair that makes the interval half-open. Getting either of
    // these backwards double-counts or drops a person on the day they move
    // between teams.
    expect(await activeIdsOn('2026-02-28')).toEqual([]);
    expect(await activeIdsOn('2026-03-01')).toEqual([id]);
    expect(await activeIdsOn('2026-05-31')).toEqual([id]);
    expect(await activeIdsOn('2026-06-01')).toEqual([]);
  });

  it('treats an open-ended row (valid_to NULL) as active for every date from its start', async () => {
    const id = await insertMembership({ validFrom: '2026-03-01', validTo: null });
    expect(await activeIdsOn('2026-03-01')).toEqual([id]);
    expect(await activeIdsOn('2099-12-31')).toEqual([id]);
    expect(await activeIdsOn('2026-02-28')).toEqual([]);
  });

  it('lets adjacent ranges hand over on the same day with no gap and no overlap', async () => {
    // [Jan, Apr) then [Apr, NULL) — the exact shape produced by ending a
    // membership and starting its replacement on the same date. Exactly one is
    // active on the handover day.
    const first = await insertMembership({ validFrom: '2026-01-01', validTo: '2026-04-01' });
    const second = await insertMembership({ validFrom: '2026-04-01', validTo: null });

    expect(await activeIdsOn('2026-03-31')).toEqual([first]);
    expect(await activeIdsOn('2026-04-01')).toEqual([second]);
  });
});

describe('endEffective', () => {
  it('closes an open row, stamps the actor, and reports the subject', async () => {
    const id = await insertMembership({ validFrom: '2026-03-01' });

    const result = await db.transaction().execute((trx) =>
      endEffective(trx, {
        table: 'platform.team_membership',
        id,
        validTo: '2026-09-01',
        actorPersonId: otherPersonId,
      }),
    );

    expect(result).toEqual({ personId, validFrom: '2026-03-01' });
    const row = await db
      .selectFrom('platform.team_membership')
      .select(['valid_to', 'updated_by'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.valid_to).toBe('2026-09-01');
    expect(row.updated_by).toBe(otherPersonId);
    expect(await activeIdsOn('2026-09-01')).toEqual([]);
  });

  it('refuses to re-end an already-ended row', async () => {
    // Re-ending would silently move a boundary that other records may already
    // have been read against — that is a correction, and corrections are a
    // separate, separately-journalled act.
    const id = await insertMembership({ validFrom: '2026-03-01', validTo: '2026-06-01' });

    await expect(
      db.transaction().execute((trx) =>
        endEffective(trx, {
          table: 'platform.team_membership',
          id,
          validTo: '2026-07-01',
          actorPersonId: personId,
        }),
      ),
    ).rejects.toThrow(/already ended/);

    const row = await db
      .selectFrom('platform.team_membership')
      .select('valid_to')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.valid_to).toBe('2026-06-01');
  });

  it('refuses an end date at or before the start date', async () => {
    const id = await insertMembership({ validFrom: '2026-03-01' });
    for (const validTo of ['2026-03-01', '2026-02-01']) {
      await expect(
        db.transaction().execute((trx) =>
          endEffective(trx, {
            table: 'platform.team_membership',
            id,
            validTo,
            actorPersonId: personId,
          }),
        ),
      ).rejects.toThrow(/must be after/);
    }
  });

  it('refuses an unknown row rather than silently updating nothing', async () => {
    await expect(
      db.transaction().execute((trx) =>
        endEffective(trx, {
          table: 'platform.team_membership',
          id: newUuidV7(),
          validTo: '2026-09-01',
          actorPersonId: personId,
        }),
      ),
    ).rejects.toThrow(/not found/);
  });

  it('rolls back with its caller — the update is not committed independently', async () => {
    // The signature takes a Transaction so a state change and its journal event
    // commit together (ADR-0010). Prove the boundary actually holds.
    const id = await insertMembership({ validFrom: '2026-03-01' });

    await expect(
      db.transaction().execute(async (trx) => {
        await endEffective(trx, {
          table: 'platform.team_membership',
          id,
          validTo: '2026-09-01',
          actorPersonId: personId,
        });
        throw new Error('caller failed after the end-date');
      }),
    ).rejects.toThrow('caller failed after the end-date');

    const row = await db
      .selectFrom('platform.team_membership')
      .select('valid_to')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.valid_to).toBeNull();
  });
});

describe('the database enforces the temporal invariant, not the application', () => {
  it('rejects two overlapping memberships for the same person and team', async () => {
    await insertMembership({ validFrom: '2026-01-01', validTo: '2026-06-01' });
    await expect(
      insertMembership({ validFrom: '2026-05-01', validTo: '2026-08-01' }),
    ).rejects.toThrow(/team_membership_no_overlap/);
  });

  it('allows the same window for a different person in the same team', async () => {
    await insertMembership({ validFrom: '2026-01-01' });
    await expect(
      insertMembership({ validFrom: '2026-01-01', person: otherPersonId }),
    ).resolves.toBeTruthy();
  });
});
