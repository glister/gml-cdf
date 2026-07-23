import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db } from './client.js';
import { newUuidV7 } from './ids.js';
import { createMigrator } from './migrator.js';
import { relayOutboxBatch, recordConsumptionOnce } from './outbox.js';
import type { NewDomainEvent } from './index.js';

/**
 * Real-Postgres validation of the outbox primitives (core plan 02 §5.2 / §10 /
 * AC-D3, AC-D7). Ordering, `FOR UPDATE SKIP LOCKED` and the guard-permitted
 * stamp cannot be proven by a mock DB (ADR-0004). Runs against `cdf_test`.
 *
 * The journal is append-only (no TRUNCATE), so tests can't wipe it. Instead each
 * test **drains** any pre-existing unpublished rows (a no-op publish that stamps
 * them) so it starts from a clean outbox, then works with its own freshly
 * inserted, correlation-tagged rows.
 */

async function drainOutbox(): Promise<void> {
  // Stamp everything currently unpublished so the next test sees an empty outbox.
  while ((await relayOutboxBatch(db, 500, async () => {})) > 0) {
    /* keep draining */
  }
}

/** Insert `n` unpublished events tagged with `correlationId`, in order. */
async function seed(n: number, correlationId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const row: NewDomainEvent = {
      id: newUuidV7(),
      stream_type: 'platform.demo',
      stream_id: newUuidV7(),
      event_type: 'platform.demo.pinged',
      payload: { note: `n${i}` },
      schema_version: 1,
      correlation_id: correlationId,
    };
    await db.insertInto('platform.domain_event').values(row).execute();
    ids.push(row.id as string);
  }
  return ids;
}

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(drainOutbox);

describe('relayOutboxBatch', () => {
  it('publishes unpublished rows in (recorded_at, id) order and stamps them', async () => {
    const correlationId = newUuidV7();
    const ids = await seed(250, correlationId); // > 2 batches

    const published: string[] = [];
    let n: number;
    do {
      n = await relayOutboxBatch(db, 100, async (events) => {
        published.push(...events.map((e) => e.id));
      });
    } while (n > 0);

    // Every seeded row was published exactly once, in insertion order.
    const mine = published.filter((id) => ids.includes(id));
    expect(mine).toEqual(ids);
    expect(new Set(mine).size).toBe(ids.length); // no duplicates

    // All are now stamped.
    const unpublished = await db
      .selectFrom('platform.domain_event')
      .select('id')
      .where('correlation_id', '=', correlationId)
      .where('published_at', 'is', null)
      .execute();
    expect(unpublished).toEqual([]);
  });

  it('does NOT stamp when publish throws (at-least-once)', async () => {
    const correlationId = newUuidV7();
    const ids = await seed(3, correlationId);

    await expect(
      relayOutboxBatch(db, 100, async () => {
        throw new Error('broker down');
      }),
    ).rejects.toThrow('broker down');

    const stillUnpublished = await db
      .selectFrom('platform.domain_event')
      .select('id')
      .where('correlation_id', '=', correlationId)
      .where('published_at', 'is', null)
      .execute();
    expect(stillUnpublished.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('two concurrent relays claim disjoint batches (FOR UPDATE SKIP LOCKED)', async () => {
    const correlationId = newUuidV7();
    await seed(6, correlationId);

    const claimA: string[] = [];
    const claimB: string[] = [];
    let signalA!: () => void;
    let signalB!: () => void;
    const startedA = new Promise<void>((r) => (signalA = r));
    const startedB = new Promise<void>((r) => (signalB = r));

    // Each publish records its claim, signals it has claimed, then waits for the
    // other — so both transactions hold their row locks simultaneously.
    const pA = relayOutboxBatch(db, 3, async (events) => {
      claimA.push(...events.map((e) => e.id));
      signalA();
      await startedB;
    });
    const pB = relayOutboxBatch(db, 3, async (events) => {
      claimB.push(...events.map((e) => e.id));
      signalB();
      await startedA;
    });
    await Promise.all([pA, pB]);

    // No id claimed by both — SKIP LOCKED guarantees disjoint claims.
    const overlap = claimA.filter((id) => claimB.includes(id));
    expect(overlap).toEqual([]);
    expect(claimA.length).toBe(3);
    expect(claimB.length).toBe(3);
  });
});

describe('recordConsumptionOnce', () => {
  it('returns true once, false on a duplicate delivery', async () => {
    const consumer = `test-${newUuidV7()}`;
    const eventId = newUuidV7();

    const first = await db
      .transaction()
      .execute((trx) => recordConsumptionOnce(trx, consumer, eventId));
    const second = await db
      .transaction()
      .execute((trx) => recordConsumptionOnce(trx, consumer, eventId));

    expect(first).toBe(true);
    expect(second).toBe(false);

    // Exactly one ledger row.
    const rows = await db
      .selectFrom('platform.event_consumption')
      .select('event_id')
      .where('consumer', '=', consumer)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('distinguishes consumers for the same event', async () => {
    const eventId = newUuidV7();
    const a = await db
      .transaction()
      .execute((trx) => recordConsumptionOnce(trx, `a-${eventId}`, eventId));
    const b = await db
      .transaction()
      .execute((trx) => recordConsumptionOnce(trx, `b-${eventId}`, eventId));
    expect(a).toBe(true);
    expect(b).toBe(true); // different consumer, same event → both first-time
  });
});

describe('watermark paging (AC-D7 — feed contract for plan 15)', () => {
  it('pages by (recorded_at, id) with correct order, no gaps, no duplicates', async () => {
    const correlationId = newUuidV7();
    const ids = await seed(120, correlationId);

    // Page over a fixed-width, microsecond-precision TEXT sort key — the same
    // shape as the production keyset helper (`timestampSortKey`). A JS `Date`
    // cursor holds only ms precision and would truncate the boundary, dropping
    // or duplicating rows whose recorded_at shares a millisecond (ADR-0004).
    const sortKey = sql<string>`to_char(recorded_at, 'YYYY-MM-DD HH24:MI:SS.US')`;
    const pageSize = 25;
    const seen: string[] = [];
    let cursor: { key: string; id: string } | null = null;

    for (;;) {
      let q = db
        .selectFrom('platform.domain_event')
        .select(['id', sortKey.as('sort_key')])
        .where('correlation_id', '=', correlationId)
        .orderBy(sortKey)
        .orderBy('id')
        .limit(pageSize);
      if (cursor) {
        const c = cursor;
        q = q.where((eb) =>
          eb.or([eb(sortKey, '>', c.key), eb.and([eb(sortKey, '=', c.key), eb('id', '>', c.id)])]),
        );
      }
      const page = await q.execute();
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.id));
      const last = page.at(-1)!;
      cursor = { key: last.sort_key, id: last.id };
    }

    expect(seen).toEqual(ids); // exact order, every row once
    expect(new Set(seen).size).toBe(ids.length); // no duplicates
  });
});
