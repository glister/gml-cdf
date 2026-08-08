import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, db, newUuidV7, type NewPerson } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { calendarOutlookSyncEnabled, demoSourceRef, setConfig, DEMO_SOURCE_KEY } from '@repo/trpc';
import { GraphPermanentError, GraphTransientError, type GraphClient } from '@repo/m365';
import type { Logger } from 'winston';
import type { ServiceBusReceivedMessage } from '@repo/service-bus';
import { EVENT_ENVELOPE_VERSION } from '../relay/envelope.js';
import { handleCalendarSync, type CalendarSyncDeps } from './calendar-outlook-sync.js';
import type { HandlerContext } from '../types.js';

/**
 * The Outlook sync rail (core plan 12 §10, PL-024).
 *
 * **Real Postgres, mocked Graph.** The half that must be proved here is ours:
 * the sync-state upsert and its transactionId, the hash no-op, the
 * journal-in-the-same-transaction rule, and the stale-redelivery guard. All of
 * those are database behaviour. Graph is a scripted client, because a real
 * tenant is not available in CI and the retry policy it stands on is already
 * covered by `@repo/m365`'s own suite.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

let personId: string;

beforeEach(async () => {
  await truncateAll(db);
  personId = await insertPerson({ display_name: 'Ada' });
  await enableSync(true);
});

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const ctx: HandlerContext = { db, logger };

async function insertPerson(overrides: Partial<NewPerson> = {}): Promise<string> {
  const id = overrides.id ?? newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'employee', display_name: 'P', ...overrides })
    .execute();
  return id;
}

async function enableSync(enabled: boolean): Promise<void> {
  await db.transaction().execute((trx) =>
    setConfig(trx, {
      def: calendarOutlookSyncEnabled,
      value: enabled,
      actorPersonId: personId,
      correlationId: newUuidV7(),
    }),
  );
}

/** A scripted Graph client: records every call, answers from a queue. */
function fakeGraph(script: { status: number; body?: unknown }[] = []) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const client: GraphClient = {
    async request(path, init) {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ method, path, body });
      const next = script.shift() ?? {
        status: 201,
        body: { id: `graph-${calls.length}` },
      };
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
      });
    },
    async requestAbsolute() {
      throw new Error('not used');
    },
  };
  return { client, calls };
}

function deps(graph: ReturnType<typeof fakeGraph>): CalendarSyncDeps {
  return {
    graphClient: () => graph.client,
    // Every person in this suite has a mailbox unless a test says otherwise.
    resolveMailbox: async () => 'entra-object-id',
  };
}

/** Journal a demo event, exactly as `platform.calendar.demoOutlookSync` does. */
async function emit(
  eventType:
    | 'platform.demo.calendar_item_approved'
    | 'platform.demo.calendar_item_rescheduled'
    | 'platform.demo.calendar_item_cancelled',
  payload: Record<string, unknown>,
): Promise<ServiceBusReceivedMessage> {
  const event = await db.transaction().execute((trx) =>
    appendEvent(trx, {
      streamType: 'platform.demo',
      streamId: personId,
      eventType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payload as any,
      actorPersonId: personId,
      correlationId: newUuidV7(),
    }),
  );

  return {
    body: {
      envelopeVersion: EVENT_ENVELOPE_VERSION,
      id: event.id,
      kind: event.kind,
      streamType: event.stream_type,
      streamId: event.stream_id,
      eventType: event.event_type,
      schemaVersion: event.schema_version,
      payload: event.payload,
      actorPersonId: event.actor_person_id,
      onBehalfOf: null,
      correlationId: event.correlation_id,
      causationId: null,
      occurredAt: new Date(event.occurred_at).toISOString(),
      recordedAt: new Date(event.recorded_at).toISOString(),
    },
  } as ServiceBusReceivedMessage;
}

async function syncState(ref = 'demo') {
  return db
    .selectFrom('platform.calendar_sync_state')
    .selectAll()
    .where('source_ref', '=', demoSourceRef(personId, ref))
    .executeTakeFirst();
}

/**
 * Journal rows for **this test's** sync-state row.
 *
 * Scoped by stream, not just by type: `platform.domain_event` is append-only,
 * so `truncateAll` deliberately leaves it alone and every test in this file
 * shares one journal. A type-only query would read the previous test's history
 * and pass or fail for reasons that have nothing to do with the case at hand.
 */
async function journalled(eventType: string, streamId?: string) {
  const id = streamId ?? (await syncState())?.id ?? '00000000-0000-0000-0000-000000000000';
  return db
    .selectFrom('platform.domain_event')
    .selectAll()
    .where('event_type', '=', eventType)
    .where('stream_id', '=', id)
    .execute();
}

/** Consumption-ledger rows for one event id — the table is append-only too. */
async function consumedRows(eventId: string) {
  return db
    .selectFrom('platform.event_consumption')
    .selectAll()
    .where('event_id', '=', eventId)
    .execute();
}

const ITEM = { ref: 'demo', startsOn: '2026-08-10', endsOn: '2026-08-14' };

describe('create', () => {
  it('creates the Outlook event, stores its id and hash, and journals the fact', async () => {
    const graph = fakeGraph([{ status: 201, body: { id: 'evt-1' } }]);
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_approved', ITEM),
      ctx,
      deps(graph),
    );

    const state = await syncState();
    expect(state?.status).toBe('synced');
    expect(state?.graph_event_id).toBe('evt-1');
    expect(state?.last_synced_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(state?.source_key).toBe(DEMO_SOURCE_KEY);

    const events = await journalled('platform.calendar_sync_state.outlook_event_created');
    expect(events).toHaveLength(1);
    expect(events[0]!.stream_id).toBe(state!.id);
    expect(events[0]!.payload).toMatchObject({ graphEventId: 'evt-1', sourceKey: DEMO_SOURCE_KEY });
  });

  it('sends the sync-state id as the Graph transactionId', async () => {
    const graph = fakeGraph([{ status: 201, body: { id: 'evt-1' } }]);
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_approved', ITEM),
      ctx,
      deps(graph),
    );

    const state = await syncState();
    expect(graph.calls[0]!.body).toMatchObject({ transactionId: state!.id });
  });

  it('projects the inclusive end date as Graph’s exclusive one', async () => {
    const graph = fakeGraph([{ status: 201, body: { id: 'evt-1' } }]);
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_approved', ITEM),
      ctx,
      deps(graph),
    );

    expect(graph.calls[0]!.body).toMatchObject({
      isAllDay: true,
      start: { dateTime: '2026-08-10T00:00:00', timeZone: 'Europe/London' },
      end: { dateTime: '2026-08-15T00:00:00', timeZone: 'Europe/London' },
      showAs: 'oof',
    });
  });

  it('is idempotent under redelivery — one Outlook event, one journal row', async () => {
    const graph = fakeGraph([{ status: 201, body: { id: 'evt-1' } }]);
    const message = await emit('platform.demo.calendar_item_approved', ITEM);

    await handleCalendarSync(message, ctx, deps(graph));
    await handleCalendarSync(message, ctx, deps(graph));

    expect(graph.calls).toHaveLength(1);
    expect(await journalled('platform.calendar_sync_state.outlook_event_created')).toHaveLength(1);
  });

  it('creates nothing when the item was cancelled before the message was handled', async () => {
    const graph = fakeGraph();
    const approval = await emit('platform.demo.calendar_item_approved', ITEM);
    // The cancellation lands first; the approval is the stale redelivery.
    await emit('platform.demo.calendar_item_cancelled', { ref: 'demo' });

    await handleCalendarSync(approval, ctx, deps(graph));

    expect(graph.calls).toHaveLength(0);
    expect(await syncState()).toBeUndefined();
  });
});

describe('update', () => {
  async function createFirst(graph: ReturnType<typeof fakeGraph>) {
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_approved', ITEM),
      ctx,
      deps(graph),
    );
  }

  it('patches the same Outlook event when the dates move', async () => {
    const graph = fakeGraph([
      { status: 201, body: { id: 'evt-1' } },
      { status: 200, body: {} },
    ]);
    await createFirst(graph);

    await handleCalendarSync(
      await emit('platform.demo.calendar_item_rescheduled', { ...ITEM, endsOn: '2026-08-18' }),
      ctx,
      deps(graph),
    );

    expect(graph.calls[1]!.method).toBe('PATCH');
    expect(graph.calls[1]!.path).toContain('evt-1');
    expect(graph.calls[1]!.body).toMatchObject({ end: { dateTime: '2026-08-19T00:00:00' } });
    expect((await syncState())?.status).toBe('synced');
    expect(await journalled('platform.calendar_sync_state.outlook_event_updated')).toHaveLength(1);
  });

  it('does nothing when the projection has not changed', async () => {
    const graph = fakeGraph([{ status: 201, body: { id: 'evt-1' } }]);
    await createFirst(graph);

    // Same dates: the hash matches, so there is nothing worth telling Graph.
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_rescheduled', ITEM),
      ctx,
      deps(graph),
    );

    expect(graph.calls).toHaveLength(1);
    expect(await journalled('platform.calendar_sync_state.outlook_event_updated')).toHaveLength(0);
    expect((await syncState())?.status).toBe('synced');
  });
});

describe('cancel', () => {
  it('deletes via the stored id and journals the outcome', async () => {
    const graph = fakeGraph([
      { status: 201, body: { id: 'evt-1' } },
      { status: 204, body: undefined },
    ]);
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_approved', ITEM),
      ctx,
      deps(graph),
    );
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_cancelled', { ref: 'demo' }),
      ctx,
      deps(graph),
    );

    expect(graph.calls[1]!.method).toBe('DELETE');
    expect(graph.calls[1]!.path).toContain('evt-1');
    expect((await syncState())?.status).toBe('cancelled');

    const events = await journalled('platform.calendar_sync_state.outlook_event_cancelled');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ alreadyGone: false });
  });

  it('treats a Graph 404 as success, and says so', async () => {
    const graph = fakeGraph([
      { status: 201, body: { id: 'evt-1' } },
      { status: 404, body: { error: { code: 'ErrorItemNotFound' } } },
    ]);
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_approved', ITEM),
      ctx,
      deps(graph),
    );
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_cancelled', { ref: 'demo' }),
      ctx,
      deps(graph),
    );

    expect((await syncState())?.status).toBe('cancelled');
    const events = await journalled('platform.calendar_sync_state.outlook_event_cancelled');
    expect(events[0]!.payload).toMatchObject({ alreadyGone: true });
  });

  it('does nothing at all for an item that was never created', async () => {
    const graph = fakeGraph();
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_cancelled', { ref: 'demo' }),
      ctx,
      deps(graph),
    );

    expect(graph.calls).toHaveLength(0);
    expect(await syncState()).toBeUndefined();
  });
});

describe('failure', () => {
  it('marks a permanent Graph refusal failed and journals a code, not a message', async () => {
    const graph = fakeGraph([{ status: 403, body: { error: { code: 'ErrorAccessDenied' } } }]);
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_approved', ITEM),
      ctx,
      deps(graph),
    );

    const state = await syncState();
    expect(state?.status).toBe('failed');
    expect(state?.attempts).toBe(1);
    expect(state?.last_error).toBeTruthy();

    const events = await journalled('platform.calendar_sync_state.outlook_sync_failed');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ errorCode: 'graph_403', operation: 'create' });
    // The payload carries a code and nothing Graph said (ADR-0019).
    expect(JSON.stringify(events[0]!.payload)).not.toContain('ErrorAccessDenied');
  });

  it('rethrows a transient failure so the queue redelivers, leaving no journal row', async () => {
    const graph = {
      client: {
        request: async () => {
          throw new GraphTransientError(503, 'busy');
        },
        requestAbsolute: async () => {
          throw new Error('not used');
        },
      } as GraphClient,
      calls: [],
    };

    const message = await emit('platform.demo.calendar_item_approved', ITEM);
    const transient = { id: (message.body as { id: string }).id };

    await expect(
      handleCalendarSync(message, ctx, deps(graph as ReturnType<typeof fakeGraph>)),
    ).rejects.toThrow(GraphTransientError);

    // The whole transaction rolled back — including the consumption ledger row,
    // which is what makes redelivery actually retry rather than dedupe away.
    expect(await syncState()).toBeUndefined();
    expect(await consumedRows(transient.id)).toHaveLength(0);
  });

  it('records a person with no mailbox against the item instead of failing silently', async () => {
    const graph = fakeGraph();
    await handleCalendarSync(await emit('platform.demo.calendar_item_approved', ITEM), ctx, {
      graphClient: () => graph.client,
      resolveMailbox: async () => null,
    });

    expect((await syncState())?.status).toBe('failed');
    const events = await journalled('platform.calendar_sync_state.outlook_sync_failed');
    expect(events[0]!.payload).toMatchObject({ errorCode: 'no_mailbox' });
    expect(graph.calls).toHaveLength(0);
  });
});

describe('the master switch', () => {
  it('no-ops entirely when calendar sync is disabled', async () => {
    await enableSync(false);
    const graph = fakeGraph();
    const message = await emit('platform.demo.calendar_item_approved', ITEM);

    await handleCalendarSync(message, ctx, deps(graph));

    expect(graph.calls).toHaveLength(0);
    expect(await syncState()).toBeUndefined();
    // Not consumed either: enabling the switch and redelivering must work.
    expect(await consumedRows((message.body as { id: string }).id)).toHaveLength(0);
  });
});

describe('events this subscription does not own', () => {
  it('ignores them without touching anything', async () => {
    const graph = fakeGraph();
    const message = await emit('platform.demo.calendar_item_approved', ITEM);
    (message.body as { eventType: string }).eventType = 'platform.demo.pinged';

    await handleCalendarSync(message, ctx, deps(graph));

    expect(graph.calls).toHaveLength(0);
    expect(await syncState()).toBeUndefined();
  });
});

describe('journal atomicity (ADR-0010)', () => {
  it('never leaves a sync-state change without its event', async () => {
    const graph = fakeGraph([
      { status: 201, body: { id: 'evt-1' } },
      { status: 200, body: {} },
      { status: 204, body: undefined },
    ]);
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_approved', ITEM),
      ctx,
      deps(graph),
    );
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_rescheduled', { ...ITEM, endsOn: '2026-08-20' }),
      ctx,
      deps(graph),
    );
    await handleCalendarSync(
      await emit('platform.demo.calendar_item_cancelled', { ref: 'demo' }),
      ctx,
      deps(graph),
    );

    const state = await syncState();
    const facts = await db
      .selectFrom('platform.domain_event')
      .select(['event_type', 'stream_type', 'stream_id', 'causation_id'])
      .where('stream_type', '=', 'platform.calendar_sync_state')
      .where('stream_id', '=', state!.id)
      .orderBy('recorded_at')
      .orderBy('id')
      .execute();

    expect(facts.map((f) => f.event_type)).toEqual([
      'platform.calendar_sync_state.outlook_event_created',
      'platform.calendar_sync_state.outlook_event_updated',
      'platform.calendar_sync_state.outlook_event_cancelled',
    ]);
    // Each one caused by the demo event that triggered it.
    expect(facts.every((f) => f.causation_id !== null)).toBe(true);
  });
});

describe('GraphPermanentError is distinguished from a transient one', () => {
  it('does not rethrow a permanent error', async () => {
    const graph = {
      client: {
        request: async () => {
          throw new GraphPermanentError(400, 'malformed');
        },
        requestAbsolute: async () => {
          throw new Error('not used');
        },
      } as GraphClient,
      calls: [],
    };

    await expect(
      handleCalendarSync(
        await emit('platform.demo.calendar_item_approved', ITEM),
        ctx,
        deps(graph as ReturnType<typeof fakeGraph>),
      ),
    ).resolves.toBeUndefined();

    expect((await syncState())?.status).toBe('failed');
  });
});
