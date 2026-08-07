import { describe, expect, it, vi } from 'vitest';
import type { Kysely, Transaction } from 'kysely';
import { createLogger } from '@repo/logging';
import type { DB } from '@repo/db';
import type { ServiceBusReceivedMessage } from '@repo/service-bus';
import { EVENT_ENVELOPE_VERSION } from '../relay/envelope.js';
import type { HandlerContext } from '../types.js';

// The handler's consumeOnce uses the real recordConsumptionOnce by default;
// mock it so the test runs without a database.
const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn<() => Promise<boolean>>() }));
vi.mock('@repo/db', async (orig) => ({
  ...(await orig<typeof import('@repo/db')>()),
  recordConsumptionOnce: recordMock,
}));

const { pilotDemoHandler } = await import('./pilot-demo.js');

const SENTINEL_TRX = {} as Transaction<DB>;
const fakeDb = {
  transaction: () => ({ execute: (cb: (trx: Transaction<DB>) => unknown) => cb(SENTINEL_TRX) }),
} as unknown as Kysely<DB>;

function ctx(): HandlerContext & { logger: ReturnType<typeof createLogger> } {
  return { logger: createLogger({ service: 'pilot-test', level: 'silent' }), db: fakeDb };
}

function envelopeMessage(overrides: Record<string, unknown> = {}): ServiceBusReceivedMessage {
  return {
    body: {
      envelopeVersion: EVENT_ENVELOPE_VERSION,
      id: '019018a0-0000-7000-8000-000000000001',
      kind: 'domain',
      streamType: 'platform.demo',
      streamId: '019018a0-0000-7000-8000-000000000002',
      eventType: 'platform.demo.pinged',
      schemaVersion: 1,
      payload: { note: 'hello' },
      actorPersonId: null,
      onBehalfOf: null,
      correlationId: '019018a0-0000-7000-8000-000000000003',
      causationId: null,
      occurredAt: '2020-01-01T00:00:00.000Z',
      recordedAt: '2020-01-01T00:00:01.000Z',
      ...overrides,
    },
  } as ServiceBusReceivedMessage;
}

describe('pilotDemoHandler', () => {
  it('consumes a valid event once and logs the note', async () => {
    recordMock.mockResolvedValue(true);
    const c = ctx();
    const info = vi.spyOn(c.logger, 'info');

    await pilotDemoHandler(envelopeMessage(), c);

    expect(recordMock).toHaveBeenCalledWith(SENTINEL_TRX, 'pilot-demo', expect.any(String));
    expect(info).toHaveBeenCalledWith(
      'pilot-demo consumed',
      expect.objectContaining({ note: 'hello' }),
    );
  });

  it('ignores a duplicate delivery without re-running the side effect', async () => {
    recordMock.mockResolvedValue(false);
    const c = ctx();
    const info = vi.spyOn(c.logger, 'info');
    const debug = vi.spyOn(c.logger, 'debug');

    await pilotDemoHandler(envelopeMessage(), c);

    expect(info).not.toHaveBeenCalledWith('pilot-demo consumed', expect.anything());
    expect(debug).toHaveBeenCalledWith('pilot-demo duplicate ignored', expect.anything());
  });

  it('ignores an event of another type without touching the consumption ledger', async () => {
    // An unfiltered topic subscription receives every relayed journal event.
    // Parsing another one's payload against this registry entry would throw,
    // abandon the message and cycle it to the dead-letter queue — for an event
    // that was relayed perfectly correctly.
    recordMock.mockClear();
    recordMock.mockResolvedValue(true);
    const c = ctx();
    const info = vi.spyOn(c.logger, 'info');

    await expect(
      pilotDemoHandler(
        envelopeMessage({
          eventType: 'platform.notification.requested',
          streamType: 'platform.notification',
          payload: { kind: 'admin.test', recipientKind: 'role', channels: [], effects: [] },
        }),
        c,
      ),
    ).resolves.toBeUndefined();

    expect(recordMock).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalledWith('pilot-demo consumed', expect.anything());
  });

  it('throws on a malformed envelope (message is abandoned/redelivered)', async () => {
    recordMock.mockResolvedValue(true);
    await expect(
      pilotDemoHandler({ body: { not: 'an envelope' } } as ServiceBusReceivedMessage, ctx()),
    ).rejects.toThrow();
  });

  it('throws when the payload violates the registry schema', async () => {
    recordMock.mockResolvedValue(true);
    await expect(
      pilotDemoHandler(envelopeMessage({ payload: { note: 'ok', leak: 'x' } }), ctx()),
    ).rejects.toThrow();
  });
});
