import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { z } from 'zod';
import { db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import {
  ConfigEffectiveFromError,
  ConfigWriteConflictError,
  getConfig,
  parseConfigRef,
  resetConfig,
  resolveConfig,
  setConfig,
} from './resolve.js';
import {
  ConfigValueInvalidError,
  defineConfigKey,
  unregisterConfigKeyForTests,
} from './registry.js';
import { externalAccessDefaultDays } from './keys.js';

/**
 * Supersede, as-at resolution and immutability (core plan 06 tests 10-T2…T6).
 *
 * Real Postgres throughout, and not as a matter of taste: the tiling of validity
 * windows, the partial unique index, the close-only guard trigger and the
 * first-ever-write race are all SQL semantics. A mock-DB test would assert
 * nothing about any of them (ADR-0004, §10 real-Postgres rule).
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let actorId: string;
/**
 * Per-test, because the journal is append-only: `truncateAll` deliberately skips
 * it and it has no FK path from a truncated table, so rows accumulate across the
 * suite. Filtering the journal by this test's correlation id is the "per-test
 * scratch rows" discipline `@repo/db/test-support` documents.
 */
let correlationId: string;

beforeEach(async () => {
  await truncateAll(db);
  actorId = newUuidV7();
  correlationId = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id: actorId, relationship_type: 'employee', display_name: 'Config Admin' })
    .execute();
});

/** A scratch key per suite, so tests never depend on a shipped key's default. */
const scratchKey = defineConfigKey({
  namespace: 'platform.test',
  key: 'threshold_days',
  schema: z.number().int().min(1).max(999),
  defaultValue: 7,
  description: 'scratch threshold for the config store suite',
  editableBy: ['administrator'],
  registeredBy: 'test',
});

afterAll(() => unregisterConfigKeyForTests('platform.test.threshold_days'));

/** Run one supersede in its own transaction, as a procedure would. */
async function set(value: number, effectiveFrom?: Date) {
  return db.transaction().execute((trx) =>
    setConfig(trx, {
      def: scratchKey,
      value,
      actorPersonId: actorId,
      effectiveFrom,
      correlationId,
    }),
  );
}

async function reset() {
  return db
    .transaction()
    .execute((trx) => resetConfig(trx, { def: scratchKey, actorPersonId: actorId, correlationId }));
}

async function events() {
  return db
    .selectFrom('platform.domain_event')
    .selectAll()
    .where('stream_type', '=', 'platform.config_entry')
    .where('correlation_id', '=', correlationId)
    .orderBy('recorded_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

// --- 10-T3 supersede mechanics ---------------------------------------------

describe('supersede mechanics (10-T3)', () => {
  it('versions from 1, closes the predecessor at the successor’s valid_from', async () => {
    const first = await set(30);
    const second = await set(45);

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);

    const rows = await db
      .selectFrom('platform.config_entry')
      .selectAll()
      .orderBy('version', 'asc')
      .execute();

    expect(rows).toHaveLength(2);
    // Windows tile exactly: no gap, no overlap, so every instant resolves to
    // exactly one row.
    expect(rows[0]!.valid_to).toEqual(rows[1]!.valid_from);
    expect(rows[1]!.valid_to).toBeNull();
    expect(rows.filter((r) => r.valid_to === null)).toHaveLength(1);
  });

  it('rejects a second open row for the same key (partial unique index)', async () => {
    await set(30);
    await expect(
      db
        .insertInto('platform.config_entry')
        .values({
          id: newUuidV7(),
          namespace: scratchKey.namespace,
          key: scratchKey.key,
          value: sql`'99'::jsonb`,
          valid_from: new Date(),
          valid_to: null,
          version: 99,
          created_by: actorId,
          updated_by: actorId,
        })
        .execute(),
    ).rejects.toThrow(/config_entry_one_open_uq/);
  });

  it('refuses a direct UPDATE of a value, a DELETE, and a reopen (10-T3 immutability)', async () => {
    await set(30);
    await set(45);
    const [v1, v2] = await db
      .selectFrom('platform.config_entry')
      .selectAll()
      .orderBy('version', 'asc')
      .execute();

    await expect(
      sql`UPDATE platform.config_entry SET value = '1'::jsonb WHERE id = ${v2!.id}`.execute(db),
    ).rejects.toThrow(/close-only/);
    await expect(
      sql`DELETE FROM platform.config_entry WHERE id = ${v1!.id}`.execute(db),
    ).rejects.toThrow(/never deleted/);
    // A closed row can never be reopened — that is what makes history a
    // database property rather than an application promise (ADR-0011).
    await expect(
      sql`UPDATE platform.config_entry SET valid_to = NULL WHERE id = ${v1!.id}`.execute(db),
    ).rejects.toThrow(/close-only/);
  });

  it('lets exactly one writer win the first-ever-write race, gaplessly', async () => {
    // The one race `FOR UPDATE` cannot serialise: with no predecessor row there
    // is nothing to lock, so `config_entry_one_open_uq` is the arbiter (§4.1
    // step 7). Simply firing two `set` calls would usually serialise by luck and
    // prove nothing, so writer A is held open across writer B's insert.
    let aInserted!: () => void;
    let releaseA!: () => void;
    const inserted = new Promise<void>((resolve) => (aInserted = resolve));
    const held = new Promise<void>((resolve) => (releaseA = resolve));

    const a = db.transaction().execute(async (trx) => {
      const result = await setConfig(trx, {
        def: scratchKey,
        value: 10,
        actorPersonId: actorId,
        correlationId,
      });
      aInserted();
      await held;
      return result;
    });

    await inserted;
    const b = set(20);
    // Let B reach its INSERT and block on the unique index before A commits;
    // without this, A could commit first and B would simply supersede it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseA();

    const results = await Promise.allSettled([a, b]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConfigWriteConflictError);

    // The loser leaves nothing behind: versions stay gapless.
    const rows = await db.selectFrom('platform.config_entry').selectAll().execute();
    expect(rows.map((r) => r.version)).toEqual([1]);
  });
});

// --- 10-T4 as-at resolution -------------------------------------------------

describe('as-at resolution (10-T4)', () => {
  it('resolves each instant to the version in force, and later changes never rewrite it', async () => {
    await set(30);
    const [v1] = await db.selectFrom('platform.config_entry').selectAll().execute();
    const t0 = v1!.valid_from;

    await set(45);
    const rows = await db
      .selectFrom('platform.config_entry')
      .selectAll()
      .orderBy('version', 'asc')
      .execute();
    const t1 = rows[1]!.valid_from;

    const beforeT0 = new Date(t0.getTime() - 1000);
    const midWindow = new Date(t0.getTime() + (t1.getTime() - t0.getTime()) / 2);

    // Before the first entry: the frozen code default.
    expect(await getConfig(db, scratchKey, { at: beforeT0 })).toBe(7);
    // Inside [t0, t1): v1. The boundary instant reads the NEW value — valid_from
    // is inclusive, valid_to exclusive, so the changeover is unambiguous.
    expect(await getConfig(db, scratchKey, { at: t0 })).toBe(30);
    expect(await getConfig(db, scratchKey, { at: midWindow })).toBe(30);
    expect(await getConfig(db, scratchKey, { at: t1 })).toBe(45);
    expect(await getConfig(db, scratchKey)).toBe(45);

    // Now change it again and re-assert every earlier read is byte-for-byte
    // unchanged. This is AC-D3 — the whole point of the store.
    await set(60);
    expect(await getConfig(db, scratchKey, { at: beforeT0 })).toBe(7);
    expect(await getConfig(db, scratchKey, { at: t0 })).toBe(30);
    expect(await getConfig(db, scratchKey, { at: midWindow })).toBe(30);
    expect(await getConfig(db, scratchKey, { at: t1 })).toBe(45);
    expect(await getConfig(db, scratchKey)).toBe(60);
  });

  it('reports provenance so a surface can show “default” honestly', async () => {
    const before = await resolveConfig(db, scratchKey);
    expect(before).toMatchObject({ value: 7, isDefault: true, version: null });

    await set(30);
    const after = await resolveConfig(db, scratchKey);
    expect(after).toMatchObject({ value: 30, isDefault: false, version: 1 });
  });

  it('falls back to the default after a reset, leaving history intact', async () => {
    await set(30);
    const [v1] = await db.selectFrom('platform.config_entry').selectAll().execute();

    const result = await reset();
    expect(result).toEqual({ reset: true, closedVersion: 1 });

    expect(await getConfig(db, scratchKey)).toBe(7);
    // The historical read is untouched: a reset closes a window, it never
    // deletes one.
    expect(await getConfig(db, scratchKey, { at: v1!.valid_from })).toBe(30);

    // Resetting a key already on its default is a no-op — no row, no event.
    const eventsBefore = (await events()).length;
    expect(await reset()).toEqual({ reset: false, closedVersion: null });
    expect(await events()).toHaveLength(eventsBefore);
  });
});

// --- 10-T5 future-dated changes ---------------------------------------------

describe('future-dated changes (10-T5)', () => {
  it('stages a change: current reads keep the old value until the instant passes', async () => {
    await set(30);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const staged = await set(45, tomorrow);

    expect(staged.version).toBe(2);
    // Visible in history immediately (AC-D5)…
    const rows = await db.selectFrom('platform.config_entry').selectAll().execute();
    expect(rows).toHaveLength(2);
    // …but not yet in force. Note this is exactly why "current" is not "the row
    // with valid_to IS NULL": the staged successor is the open row.
    expect(await getConfig(db, scratchKey)).toBe(30);
    expect(await getConfig(db, scratchKey, { at: new Date(tomorrow.getTime() - 1000) })).toBe(30);
    // The boundary instant itself reads the new value.
    expect(await getConfig(db, scratchKey, { at: tomorrow })).toBe(45);
  });

  it('rejects a past effectiveFrom — it would rewrite decisions already made', async () => {
    await set(30);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await expect(set(45, yesterday)).rejects.toThrow(ConfigEffectiveFromError);
    expect(await db.selectFrom('platform.config_entry').selectAll().execute()).toHaveLength(1);
  });

  it('rejects an effectiveFrom at or before the version in force', async () => {
    const first = await set(30);
    await expect(set(45, first.validFrom)).rejects.toThrow(ConfigEffectiveFromError);
  });

  it('refuses to reset while a change is staged, and says what to do instead', async () => {
    await set(30);
    await set(45, new Date(Date.now() + 24 * 60 * 60 * 1000));
    await expect(reset()).rejects.toThrow(/change staged for .* and cannot be reset/);
  });
});

// --- 10-T2 validation failures ----------------------------------------------

describe('validation (10-T2)', () => {
  it('writes nothing and journals nothing when the value fails its schema', async () => {
    await set(30);
    const before = await events();

    await expect(
      db.transaction().execute((trx) =>
        setConfig(trx, {
          def: scratchKey,
          // Out of the key's declared range; the transaction must abort whole.
          value: 5000 as never,
          actorPersonId: actorId,
          correlationId,
        }),
      ),
    ).rejects.toThrow();

    expect(await db.selectFrom('platform.config_entry').selectAll().execute()).toHaveLength(1);
    expect(await events()).toHaveLength(before.length);
  });

  it('throws on a stored value that fails its schema, rather than guessing', async () => {
    await set(30);
    // Corrupt the row the only way the guard permits — through a fresh insert
    // after closing the open one, simulating registry drift (a schema narrowed
    // under rows it must still accept).
    await sql`
      UPDATE platform.config_entry SET valid_to = now() WHERE valid_to IS NULL
    `.execute(db);
    await db
      .insertInto('platform.config_entry')
      .values({
        id: newUuidV7(),
        namespace: scratchKey.namespace,
        key: scratchKey.key,
        value: sql`'"not a number"'::jsonb`,
        valid_from: new Date(),
        valid_to: null,
        version: 2,
        created_by: actorId,
        updated_by: actorId,
      })
      .execute();

    await expect(getConfig(db, scratchKey)).rejects.toThrow(ConfigValueInvalidError);
  });
});

// --- 10-T6 admin-event emission ---------------------------------------------

describe('admin events (10-T6, PL-030)', () => {
  it('appends exactly one kind=admin event per set, with the §4.2 payload', async () => {
    await set(30);
    const [created] = await events();

    expect(created).toMatchObject({
      kind: 'admin',
      stream_type: 'platform.config_entry',
      event_type: 'platform.config_entry.changed',
      actor_person_id: actorId,
      correlation_id: correlationId,
    });
    expect(created!.payload).toMatchObject({
      namespace: 'platform.test',
      key: 'threshold_days',
      // The first entry supersedes the frozen default, not a row — which is the
      // distinction the audit view renders as "default → 30".
      fromVersion: null,
      toVersion: 1,
      oldValue: 7,
      newValue: 30,
    });

    await set(45);
    const all = await events();
    expect(all).toHaveLength(2);
    expect(all[1]!.payload).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      oldValue: 30,
      newValue: 45,
    });
  });

  it('appends a reset event naming the closed version and the default', async () => {
    await set(30);
    await reset();

    const all = await events();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ kind: 'admin', event_type: 'platform.config_entry.reset' });
    expect(all[1]!.payload).toMatchObject({ closedVersion: 1, oldValue: 30, defaultValue: 7 });
  });

  it('rolls back the entry and its event together when the transaction fails', async () => {
    // The ADR-0010 rule made testable: no entry without its event, no event
    // without its entry. Induce a failure after both writes.
    await expect(
      db.transaction().execute(async (trx) => {
        await setConfig(trx, {
          def: scratchKey,
          value: 30,
          actorPersonId: actorId,
          correlationId,
        });
        throw new Error('induced failure after the entry and its event');
      }),
    ).rejects.toThrow(/induced failure/);

    expect(await db.selectFrom('platform.config_entry').selectAll().execute()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });

  it('suppresses values for a key flagged sensitiveValue', async () => {
    const secret = defineConfigKey({
      namespace: 'platform.test',
      key: 'suppressed_value',
      schema: z.number().int(),
      defaultValue: 1,
      description: 'exercises the sensitiveValue escape hatch',
      editableBy: ['administrator'],
      registeredBy: 'test',
      sensitiveValue: true,
    });
    try {
      await db
        .transaction()
        .execute((trx) =>
          setConfig(trx, { def: secret, value: 2, actorPersonId: actorId, correlationId }),
        );
      const [event] = await events();
      expect(event!.payload).toMatchObject({ toVersion: 1 });
      expect(event!.payload).not.toHaveProperty('oldValue');
      expect(event!.payload).not.toHaveProperty('newValue');
    } finally {
      unregisterConfigKeyForTests('platform.test.suppressed_value');
    }
  });
});

// --- 9.2-T2 config: references ----------------------------------------------

describe('parseConfigRef (9.2-T2, ADR-0013)', () => {
  it('resolves a registered reference', () => {
    expect(parseConfigRef('config:platform.identity.external_access_default_days')).toBe(
      externalAccessDefaultDays,
    );
  });

  it('throws on an unknown key or a malformed reference', () => {
    // A typo in a workflow definition is a boot failure, never a transition that
    // silently takes a default.
    expect(() => parseConfigRef('config:platform.identity.nope')).toThrow(
      /unknown configuration key/,
    );
    expect(() => parseConfigRef('platform.identity.external_access_default_days')).toThrow(
      /invalid config reference/,
    );
    expect(() => parseConfigRef('config:')).toThrow(/no key name/);
  });
});
