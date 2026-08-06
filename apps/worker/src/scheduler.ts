import { db, pool } from '@repo/db';
import { parse, z } from '@repo/env';
import { createServiceBus } from '@repo/service-bus';
import { drainDueActions, SCHEDULER_BATCH_SIZE } from '@repo/workflow';
import { EFFECTS_QUEUE } from './relay/effects-fanout.js';
import { logger } from './logger.js';

/**
 * The scheduler (core plan 07 §5.5, WF-8) — the worker image's **second
 * entrypoint**, run as an Azure Container Apps cron Job every five minutes.
 *
 * It is a short batch, not a listener, which is why it is a Job rather than a
 * KEDA-scaled app: it wakes, drains every timer that has come due onto the
 * `effects` queue, and exits. Same image as the worker, so one build, one
 * dependency set, and `@repo/workflow` shared with the code that creates the
 * timers in the first place.
 *
 * The interesting SQL — `FOR UPDATE SKIP LOCKED`, send-then-stamp inside one
 * transaction — lives in `@repo/workflow` where it is exercised against real
 * Postgres. This file is the composition: environment, sender, loop, exit code.
 *
 * **Overlapping runs are safe by construction.** If a batch runs long and the
 * next cron tick starts before it finishes, `SKIP LOCKED` means the second run
 * takes different rows rather than blocking on or double-picking the first's.
 */

const env = parse(
  z.object({
    SERVICE_BUS_CONNECTION_STRING: z.string().min(1),
    VITEST: z.string().optional(),
  }),
);

export async function runScheduler(): Promise<number> {
  const sb = createServiceBus({ connectionString: env.SERVICE_BUS_CONNECTION_STRING, logger });
  const sender = sb.sender(EFFECTS_QUEUE);
  let total = 0;

  try {
    // Loop until a batch comes back short: a full batch means more may be due,
    // and a Job that drained only its first 200 timers would silently fall
    // further behind every run.
    for (;;) {
      const sent = await drainDueActions(db, SCHEDULER_BATCH_SIZE, async (actions) => {
        await sender.sendMessages(
          actions.map((action) => ({
            body: action.envelope,
            // Deterministic, so a crash between send and stamp re-sends the same
            // id and duplicate detection absorbs it (§5.5).
            messageId: action.messageId,
            subject: action.actionType,
            correlationId: action.envelope.correlationId,
            applicationProperties: { effect: action.actionType },
          })),
        );
      });
      total += sent;
      if (sent < SCHEDULER_BATCH_SIZE) break;
    }
    logger.info('scheduler run complete', { enqueued: total });
    return total;
  } finally {
    await sender.close();
    await sb.close();
  }
}

// Boots on import unless running under Vitest, matching `src/index.ts`.
if (!env.VITEST) {
  try {
    await runScheduler();
  } catch (error) {
    logger.error('scheduler run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
