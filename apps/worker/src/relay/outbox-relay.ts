import type { Kysely } from 'kysely';
import type { Logger } from 'winston';
import { relayOutboxBatch, type DB } from '@repo/db';
import type { ServiceBus } from '@repo/service-bus';
import { relayConfig } from './config.js';
import { toEnvelopeMessage } from './envelope.js';

/**
 * The outbox relay (core plan 02 §5.2). A **poller, not a message handler** —
 * nothing arrives on a queue to trigger it, so the worker must run with
 * `minReplicas = 1` (it can't scale to zero). Each tick claims a batch of
 * unpublished journal rows, publishes them to the `domain-events` topic, and
 * stamps `published_at` — publish-then-stamp inside one transaction, so a crash
 * republishes rather than loses (at-least-once; consumers dedupe).
 *
 * The SQL (claim + stamp, `FOR UPDATE SKIP LOCKED`) lives in `@repo/db`
 * (`relayOutboxBatch`); this module owns the loop, the sender, the envelope
 * mapping and the backoff.
 */

export interface OutboxRelayDeps {
  db: Kysely<DB>;
  sb: ServiceBus;
  logger: Logger;
}

export interface OutboxRelayOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  backoffMaxMs?: number;
  /**
   * Test seam: run one batch and return the number published. Defaults to the
   * Service Bus-backed relay over `relayOutboxBatch`.
   */
  runBatch?: (batchSize: number) => Promise<number>;
}

export interface OutboxRelayHandle {
  /** Stop the loop, cancel any pending wait, and close the sender. */
  stop(): Promise<void>;
}

export function startOutboxRelay(
  deps: OutboxRelayDeps,
  options: OutboxRelayOptions = {},
): OutboxRelayHandle {
  const batchSize = options.batchSize ?? relayConfig.batchSize;
  const pollIntervalMs = options.pollIntervalMs ?? relayConfig.pollIntervalMs;
  const backoffMaxMs = options.backoffMaxMs ?? relayConfig.backoffMaxMs;

  const sender = deps.sb.sender(relayConfig.topic);
  const runBatch =
    options.runBatch ??
    ((n: number): Promise<number> =>
      relayOutboxBatch(deps.db, n, async (events) => {
        await sender.sendMessages(events.map(toEnvelopeMessage));
      }));

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  // A wait that resolves either on timeout or immediately when `stop()` wakes it.
  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    });

  const loop = async (): Promise<void> => {
    let backoff = pollIntervalMs;
    while (!stopped) {
      try {
        const published = await runBatch(batchSize);
        if (stopped) break;
        backoff = pollIntervalMs; // healthy tick → reset backoff
        // A full batch means more may be waiting: poll again immediately.
        // A short batch means the outbox is drained: idle until the next tick.
        if (published < batchSize) await wait(pollIntervalMs);
      } catch (error) {
        deps.logger.error('outbox relay tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (stopped) break;
        await wait(backoff);
        backoff = Math.min(backoff * 2, backoffMaxMs);
      }
    }
  };

  const running = loop();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.(); // resolve any in-flight wait so the loop exits promptly
      await running;
      await sender.close();
    },
  };
}
