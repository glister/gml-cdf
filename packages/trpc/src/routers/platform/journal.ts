import { appendEvent, newUuidV7 } from '@repo/db';
import { roleProcedure, router } from '../../trpc.js';
import { demoPingInput, demoPingOutput } from '../../schemas.js';

/**
 * The event journal's only tRPC surface — the pilot slice (core plan 02 §5.1).
 * There is deliberately no generic `journal.append` procedure: appends happen
 * only inside server-side transactions next to their state change, so an API
 * endpoint would sever the same-transaction guarantee (anti-scope, §1).
 *
 * `demoPing` proves the rail end to end: it appends `platform.demo.pinged` in a
 * transaction; the outbox relay publishes it; the `pilot-demo` consumer handles
 * it idempotently.
 */
export const journalRouter = router({
  // Re-based off `adminProcedure` onto the domain role model (core plan 04 Q1):
  // Better Auth's admin flag now guards framework operations only.
  demoPing: roleProcedure(['administrator'], { module: 'platform' })
    .input(demoPingInput)
    .output(demoPingOutput)
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.transaction().execute((trx) =>
        appendEvent(trx, {
          streamType: 'platform.demo',
          streamId: newUuidV7(), // each ping is its own demo subject
          eventType: 'platform.demo.pinged',
          payload: { note: input.note },
          correlationId: ctx.correlationId,
          actorPersonId: ctx.actorPersonId,
        }),
      );
      ctx.logger.info('platform.journal.demoPing', { eventId: event.id });
      return { eventId: event.id };
    }),
});
