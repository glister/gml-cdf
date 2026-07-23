import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { createLogger } from '@repo/logging';
import type { DB } from '@repo/db';
import type { ServiceBus } from '@repo/service-bus';
import { startOutboxRelay } from './outbox-relay.js';

const logger = createLogger({ service: 'relay-test', level: 'silent' });
const noDb = undefined as unknown as Kysely<DB>;

function fakeSb() {
  const sender = { sendMessages: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const sb = { sender: () => sender } as unknown as ServiceBus;
  return { sb, sender };
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

describe('startOutboxRelay', () => {
  it('polls the outbox and stops cleanly, closing the sender', async () => {
    const { sb, sender } = fakeSb();
    const runBatch = vi.fn(async () => 0); // outbox always empty

    const relay = startOutboxRelay({ db: noDb, sb, logger }, { runBatch, pollIntervalMs: 2 });
    await tick();
    await relay.stop();

    expect(runBatch).toHaveBeenCalled();
    expect(sender.close).toHaveBeenCalledOnce();

    // No further ticks after stop().
    const callsAtStop = runBatch.mock.calls.length;
    await tick();
    expect(runBatch.mock.calls.length).toBe(callsAtStop);
  });

  it('re-polls immediately when a batch comes back full', async () => {
    const { sb } = fakeSb();
    let n = 0;
    // First few ticks return a full batch (→ immediate re-poll), then drain.
    const runBatch = vi.fn(async () => (n++ < 3 ? 1 : 0));

    const relay = startOutboxRelay(
      { db: noDb, sb, logger },
      { runBatch, batchSize: 1, pollIntervalMs: 50 },
    );
    await tick(15); // well under one poll interval
    await relay.stop();

    // Full batches re-poll without waiting, so we get many calls inside 15ms
    // despite the 50ms idle interval.
    expect(runBatch.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('logs and backs off on a failing tick, then continues', async () => {
    const { sb } = fakeSb();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    let calls = 0;
    const runBatch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('broker down');
      return 0;
    });

    const relay = startOutboxRelay(
      { db: noDb, sb, logger },
      { runBatch, pollIntervalMs: 2, backoffMaxMs: 8 },
    );
    await tick();
    await relay.stop();

    expect(errorSpy).toHaveBeenCalledWith('outbox relay tick failed', expect.anything());
    expect(calls).toBeGreaterThanOrEqual(2); // retried after the failure
    errorSpy.mockRestore();
  });
});
