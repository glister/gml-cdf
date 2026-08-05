import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { db, newUuidV7, type NewPerson } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { appRouter } from '../../router.js';
import type { ContextGrant, TRPCContext } from '../../trpc.js';
import { ROLE_KEYS, type RoleKey } from '../../lib/constants.js';
import { defineConfigKey, unregisterConfigKeyForTests } from '../../config/registry.js';

/**
 * The `platform.config` surface (core plan 06 §10, tests 10-T8/T9, PL-029/030).
 *
 * Real Postgres: the history procedure's keyset boundary and the supersede it
 * pages over are SQL semantics, and the RBAC checks read live grant rows.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

/**
 * Scratch keys covering the three edit policies the §8 role table describes, so
 * the RBAC tests assert against a stable set rather than whichever keys the
 * platform happens to have registered.
 */
const adminOnlyKey = defineConfigKey({
  namespace: 'platform.test_router',
  key: 'admin_only_days',
  schema: z.number().int().min(1).max(999),
  defaultValue: 30,
  description: 'admin-only scratch key for the router suite',
  editableBy: ['administrator'],
  registeredBy: 'test',
});

const hrEditableKey = defineConfigKey({
  namespace: 'platform.test_router',
  key: 'hr_editable_cadence',
  schema: z.enum(['P1D', 'P7D']),
  defaultValue: 'P1D',
  description: 'HR-editable scratch key for the router suite',
  editableBy: ['administrator', 'hr_user'],
  registeredBy: 'test',
});

afterAll(() => {
  unregisterConfigKeyForTests('platform.test_router.admin_only_days');
  unregisterConfigKeyForTests('platform.test_router.hr_editable_cadence');
});

let adminPersonId: string;
let adminGrants: ContextGrant[];

beforeEach(async () => {
  await truncateAll(db);
  await reseedRoles();
  adminPersonId = await insertPerson({ display_name: 'Config Admin' });
  adminGrants = await grantsFor(adminPersonId, ['administrator']);
});

async function reseedRoles(): Promise<void> {
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

async function insertPerson(overrides: Partial<NewPerson> = {}): Promise<string> {
  const id = overrides.id ?? newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'employee', display_name: 'Person', ...overrides })
    .execute();
  return id;
}

async function grantsFor(personId: string, roleKeys: RoleKey[]): Promise<ContextGrant[]> {
  for (const roleKey of roleKeys) {
    const role = await db
      .selectFrom('platform.role')
      .select('id')
      .where('key', '=', roleKey)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('platform.role_grant')
      .values({
        id: newUuidV7(),
        person_id: personId,
        role_id: role.id,
        module: 'platform',
        created_by: personId,
      })
      .execute();
  }
  const rows = await db
    .selectFrom('platform.role_grant as g')
    .innerJoin('platform.role as r', 'r.id', 'g.role_id')
    .select(['r.key as roleKey', 'g.module', 'g.valid_from', 'g.valid_until', 'g.revoked_at'])
    .where('g.person_id', '=', personId)
    .where('g.revoked_at', 'is', null)
    .execute();
  return rows.map((r) => ({
    roleKey: r.roleKey as RoleKey,
    module: r.module,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    revokedAt: r.revoked_at,
  }));
}

function makeCtx(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    db,
    user: { id: 'u', name: 'Admin', email: 'admin@cdf.test', role: 'admin' },
    session: { id: 's', userId: 'u' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    email: { sendOtp: async () => {}, sendInvitation: async () => {} },
    sms: { send: async () => {} },
    rateLimit: { check: () => true },
    correlationId: newUuidV7(),
    actorPersonId: adminPersonId,
    grants: adminGrants,
    ...overrides,
  };
}

const caller = () => appRouter.createCaller(makeCtx());

async function callerWith(roleKeys: RoleKey[]) {
  const personId = await insertPerson({ display_name: roleKeys.join('+') || 'no roles' });
  const grants = await grantsFor(personId, roleKeys);
  return appRouter.createCaller(makeCtx({ actorPersonId: personId, grants }));
}

const adminOnlyRef = { namespace: 'platform.test_router', key: 'admin_only_days' };
const hrRef = { namespace: 'platform.test_router', key: 'hr_editable_cadence' };

// --- list / get -------------------------------------------------------------

describe('platform.config.list', () => {
  it('lists every registered key, showing unset keys as their frozen default', async () => {
    const { items } = await caller().platform.config.list({});
    const row = items.find((i) => i.qualifiedName === 'platform.test_router.admin_only_days');

    expect(row).toMatchObject({ isDefault: true, value: 30, version: null, updatedByName: null });
    // The shipped pilot key is in the same listing — the browser is
    // registry-driven, so a key exists in it before anyone has ever set it.
    expect(items.some((i) => i.key === 'external_access_default_days')).toBe(true);
  });

  it('merges the entry in force and names who last changed it', async () => {
    await caller().platform.config.set({ ...adminOnlyRef, value: 45 });
    const { items } = await caller().platform.config.list({ namespace: 'platform.test_router' });
    const row = items.find((i) => i.key === 'admin_only_days');

    expect(row).toMatchObject({
      isDefault: false,
      value: 45,
      version: 1,
      updatedByName: 'Config Admin',
    });
  });

  it('filters by namespace and search, server-side', async () => {
    const byNamespace = await caller().platform.config.list({ namespace: 'platform.test_router' });
    expect(byNamespace.items).toHaveLength(2);
    expect(byNamespace.items.every((i) => i.namespace === 'platform.test_router')).toBe(true);

    // Search covers the description too — an administrator looking for "how
    // long does external access last" does not know the key's name.
    const bySearch = await caller().platform.config.list({ search: 'HR-editable scratch' });
    expect(bySearch.items.map((i) => i.key)).toEqual(['hr_editable_cadence']);
  });

  it('sorts unset keys last under updated_at, in both directions', async () => {
    await caller().platform.config.set({ ...adminOnlyRef, value: 45 });
    for (const sortDir of ['asc', 'desc'] as const) {
      const { items } = await caller().platform.config.list({
        namespace: 'platform.test_router',
        sort: 'updated_at',
        sortDir,
      });
      // "Never changed" is not a date; it sorts last either way rather than
      // being pinned to an arbitrary end.
      expect(items.at(-1)!.key).toBe('hr_editable_cadence');
    }
  });

  it('narrows to what the caller may actually change', async () => {
    const hr = await callerWith(['hr_user']);
    const { items } = await hr.platform.config.list({
      namespace: 'platform.test_router',
      editableOnly: true,
    });
    expect(items.map((i) => i.key)).toEqual(['hr_editable_cadence']);
  });
});

describe('platform.config.get', () => {
  it('returns an editor descriptor derived from the registered schema', async () => {
    const bounded = await caller().platform.config.get(adminOnlyRef);
    expect(bounded.schema).toMatchObject({ editorKind: 'integer', minimum: 1, maximum: 999 });

    const enumKey = await caller().platform.config.get(hrRef);
    expect(enumKey.schema).toMatchObject({ editorKind: 'enum', options: ['P1D', 'P7D'] });
  });

  it('answers as-at without disturbing the current value', async () => {
    await caller().platform.config.set({ ...adminOnlyRef, value: 45 });
    const current = await caller().platform.config.get(adminOnlyRef);
    const before = await caller().platform.config.get({
      ...adminOnlyRef,
      at: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(current.value).toBe(45);
    // Before the first entry existed the frozen default was in force.
    expect(before).toMatchObject({ value: 30, isDefault: true, version: null });
  });

  it('surfaces a staged change rather than hiding it behind "current"', async () => {
    await caller().platform.config.set({ ...adminOnlyRef, value: 45 });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    await caller().platform.config.set({ ...adminOnlyRef, value: 60, effectiveFrom: tomorrow });

    const view = await caller().platform.config.get(adminOnlyRef);
    expect(view.value).toBe(45);
    expect(view.pendingChange).toMatchObject({ version: 2, value: 60 });
  });

  it('404s an unregistered key — there is no free-form escape hatch', async () => {
    await expect(
      caller().platform.config.get({ namespace: 'platform.test_router', key: 'nope' }),
    ).rejects.toThrow(/not a registered configuration key/);
  });
});

// --- 10-T9 RBAC -------------------------------------------------------------

describe('authorisation (10-T9, ADR-0015)', () => {
  it('denies every procedure to a role without platform access', async () => {
    const employee = await callerWith(['employee']);
    await expect(employee.platform.config.list({})).rejects.toThrow(/Requires one of/);
    await expect(employee.platform.config.get(adminOnlyRef)).rejects.toThrow(/Requires one of/);
    await expect(employee.platform.config.set({ ...adminOnlyRef, value: 45 })).rejects.toThrow(
      /Requires one of/,
    );
    await expect(employee.platform.config.history(adminOnlyRef)).rejects.toThrow(/Requires one of/);
  });

  it('denies external roles outright (PL-043)', async () => {
    const external = await callerWith(['external']);
    await expect(external.platform.config.list({})).rejects.toThrow(/Requires one of/);
  });

  it('lets HR User read every key but edit only those listing hr_user', async () => {
    const hr = await callerWith(['hr_user']);

    // Reading is not gated per key: configuration is not secret, and knowing a
    // threshold is part of doing the job.
    await expect(hr.platform.config.get(adminOnlyKey)).resolves.toMatchObject({ canEdit: false });
    await expect(hr.platform.config.get(hrRef)).resolves.toMatchObject({ canEdit: true });

    await expect(hr.platform.config.set({ ...adminOnlyRef, value: 45 })).rejects.toThrow(
      /editable by \[administrator\] only/,
    );
    await expect(hr.platform.config.set({ ...hrRef, value: 'P7D' })).resolves.toMatchObject({
      version: 1,
    });
  });

  it('refuses a reset the caller could not have set', async () => {
    await caller().platform.config.set({ ...adminOnlyRef, value: 45 });
    const hr = await callerWith(['hr_user']);
    await expect(hr.platform.config.reset(adminOnlyRef)).rejects.toThrow(/editable by/);
  });
});

// --- set / reset error mapping ----------------------------------------------

describe('set and reset', () => {
  it('rejects a value failing the key’s schema with the schema’s own message', async () => {
    await expect(caller().platform.config.set({ ...adminOnlyRef, value: 5000 })).rejects.toThrow(
      /admin_only_days/,
    );
    await expect(caller().platform.config.set({ ...hrRef, value: 'P30D' })).rejects.toThrow(
      /hr_editable_cadence/,
    );
    expect(await db.selectFrom('platform.config_entry').selectAll().execute()).toHaveLength(0);
  });

  it('rejects a past effectiveFrom as a bad request, not a server error', async () => {
    await expect(
      caller().platform.config.set({
        ...adminOnlyRef,
        value: 45,
        effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('returns to the frozen default on reset, and is a no-op when already there', async () => {
    await caller().platform.config.set({ ...adminOnlyRef, value: 45 });
    expect(await caller().platform.config.reset(adminOnlyRef)).toEqual({
      reset: true,
      closedVersion: 1,
    });

    const after = await caller().platform.config.get(adminOnlyRef);
    expect(after).toMatchObject({ value: 30, isDefault: true });

    expect(await caller().platform.config.reset(adminOnlyRef)).toEqual({
      reset: false,
      closedVersion: null,
    });
  });
});

// --- 10-T8 keyset history ---------------------------------------------------

describe('platform.config.history (10-T8)', () => {
  it('pages the whole history in global order, with no duplicates and no gaps', async () => {
    // 23 versions over a 25-per-page default: enough for three pages at the
    // page size used below, so both boundaries are exercised.
    const total = 23;
    for (let i = 1; i <= total; i++) {
      await caller().platform.config.set({ ...adminOnlyRef, value: i });
    }

    const seen: { version: number; validFrom: string }[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = await caller().platform.config.history({
        ...adminOnlyRef,
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((i) => ({ version: i.version, validFrom: i.validFrom })));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10); // guard against a cursor that never advances
    } while (cursor);

    // Every version exactly once…
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((s) => s.version)).size).toBe(total);
    // …in one strict global order across page edges. `valid_from DESC` and
    // `version DESC` agree because each version starts when its predecessor
    // ends, so this also proves the windows tile.
    expect(seen.map((s) => s.version)).toEqual(Array.from({ length: total }, (_, i) => total - i));
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.validFrom <= seen[i - 1]!.validFrom).toBe(true);
    }
  });

  it('reports the closing boundary of every superseded version', async () => {
    await caller().platform.config.set({ ...adminOnlyRef, value: 45 });
    await caller().platform.config.set({ ...adminOnlyRef, value: 60 });

    const { items, defaultValue } = await caller().platform.config.history(adminOnlyRef);
    expect(defaultValue).toBe(30);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ version: 2, value: 60, validTo: null });
    expect(items[1]).toMatchObject({ version: 1, value: 45 });
    // No gap between the versions: the predecessor closes exactly where the
    // successor opens.
    expect(items[1]!.validTo).toBe(items[0]!.validFrom);
    expect(items[0]!.createdByName).toBe('Config Admin');
  });

  it('includes a staged change immediately (AC-D5)', async () => {
    await caller().platform.config.set({ ...adminOnlyRef, value: 45 });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    await caller().platform.config.set({ ...adminOnlyRef, value: 60, effectiveFrom: tomorrow });

    const { items } = await caller().platform.config.history(adminOnlyRef);
    expect(items.map((i) => i.version)).toEqual([2, 1]);
    expect(items[0]!.value).toBe(60);
  });
});
