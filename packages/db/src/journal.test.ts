import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db } from './client.js';
import { newUuidV7 } from './ids.js';
import { createMigrator } from './migrator.js';
import type { NewDomainEvent } from './index.js';

/**
 * Real-Postgres validation of the `platform.domain_event` append-only guarantees
 * (core plan 02 T3 / §10 / AC-D2). Mock-DB tests cannot prove trigger, grant or
 * `to_jsonb` behaviour — these run against `cdf_test` (`.env.test`).
 *
 * Phase 1 connects as the superuser owner (plan 01 §12.2 Q1), which bypasses the
 * REVOKE; the guard trigger is therefore the binding enforcement and what these
 * tests exercise. The REVOKE is defence-in-depth for the future role split.
 *
 * NOTE on the erasure branch: a Postgres superuser is an *implicit* member of
 * every role, so the mere existence of `cdf_erasure` would flip the guard's
 * erasure exception on for the owner. The base tests therefore run with no such
 * role present; the erasure test creates it, exercises it via a non-superuser
 * `SET LOCAL ROLE`, and drops it again in a `finally` so it never leaks into the
 * other tests or a later run.
 */

function makeRow(overrides: Partial<NewDomainEvent> = {}): NewDomainEvent {
  return {
    id: newUuidV7(),
    stream_type: 'platform.demo',
    stream_id: newUuidV7(),
    event_type: 'platform.demo.pinged',
    payload: { note: 'hello' },
    schema_version: 1,
    correlation_id: newUuidV7(),
    ...overrides,
  };
}

async function insertRow(overrides: Partial<NewDomainEvent> = {}): Promise<string> {
  const row = makeRow(overrides);
  await db.insertInto('platform.domain_event').values(row).execute();
  return row.id as string;
}

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

describe('platform.domain_event append-only guard', () => {
  it('accepts a fresh insert', async () => {
    const id = await insertRow();
    const found = await db
      .selectFrom('platform.domain_event')
      .select(['id', 'kind', 'schema_version'])
      .where('id', '=', id)
      .executeTakeFirst();
    expect(found).toMatchObject({ id, kind: 'domain', schema_version: 1 });
  });

  it('rejects UPDATE of payload', async () => {
    const id = await insertRow();
    await expect(
      db
        .updateTable('platform.domain_event')
        .set({ payload: { note: 'tampered' } })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects UPDATE of event_type', async () => {
    const id = await insertRow();
    await expect(
      db
        .updateTable('platform.domain_event')
        .set({ event_type: 'platform.demo.tampered' })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects DELETE', async () => {
    const id = await insertRow();
    await expect(
      db.deleteFrom('platform.domain_event').where('id', '=', id).execute(),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects TRUNCATE', async () => {
    await expect(sql`TRUNCATE TABLE platform.domain_event`.execute(db)).rejects.toThrow(
      /append-only/i,
    );
  });

  it('permits the outbox stamp published_at NULL -> value exactly once', async () => {
    const id = await insertRow();

    const stamped = await db
      .updateTable('platform.domain_event')
      .set({ published_at: sql`now()` })
      .where('id', '=', id)
      .returning('published_at')
      .executeTakeFirst();
    expect(stamped?.published_at).toBeTruthy();

    // A second stamp (value -> value) is not the NULL -> value transition, so
    // the guard rejects it.
    await expect(
      db
        .updateTable('platform.domain_event')
        .set({ published_at: sql`now()` })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects an UPDATE that stamps published_at AND changes another column', async () => {
    const id = await insertRow();
    await expect(
      db
        .updateTable('platform.domain_event')
        .set({ published_at: sql`now()`, event_type: 'platform.demo.sneaky' })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/append-only/i);
  });

  it('lets the erasure role redact ONLY the payload, and rejects wider changes', async () => {
    const id = await insertRow({ payload: { note: 'to-be-erased' } });
    try {
      // A NOLOGIN, non-superuser role granted only what it needs to reach and
      // redact the row — a faithful stand-in for plan 16's least-privilege
      // cdf_erasure role (schema USAGE, plus SELECT for the WHERE and UPDATE).
      await sql`CREATE ROLE cdf_erasure NOLOGIN`.execute(db);
      await sql`GRANT USAGE ON SCHEMA platform TO cdf_erasure`.execute(db);
      await sql`GRANT SELECT, UPDATE ON platform.domain_event TO cdf_erasure`.execute(db);

      // Payload-only redaction succeeds as the erasure role.
      await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE cdf_erasure`.execute(trx);
        await sql`UPDATE platform.domain_event SET payload = '{"redacted":true}'::jsonb WHERE id = ${id}`.execute(
          trx,
        );
      });

      const row = await db
        .selectFrom('platform.domain_event')
        .select('payload')
        .where('id', '=', id)
        .executeTakeFirst();
      expect(row?.payload).toMatchObject({ redacted: true });

      // A change touching any other column is rejected even for the erasure role.
      await expect(
        db.transaction().execute(async (trx) => {
          await sql`SET LOCAL ROLE cdf_erasure`.execute(trx);
          await sql`UPDATE platform.domain_event SET payload = '{}'::jsonb, event_type = 'platform.demo.x' WHERE id = ${id}`.execute(
            trx,
          );
        }),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await sql`REVOKE SELECT, UPDATE ON platform.domain_event FROM cdf_erasure`.execute(db);
      await sql`REVOKE USAGE ON SCHEMA platform FROM cdf_erasure`.execute(db);
      await sql`DROP ROLE IF EXISTS cdf_erasure`.execute(db);
    }
  });
});
