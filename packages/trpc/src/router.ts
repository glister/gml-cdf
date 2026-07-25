import { router } from './trpc.js';
import { usersRouter } from './routers/users.js';
import { identityRouter } from './routers/platform/identity.js';
import { journalRouter } from './routers/platform/journal.js';

/**
 * Composition root: merge every feature router from `./routers/*` here.
 * Module routers compose under their schema namespace (ADR-0008).
 */
export const appRouter = router({
  users: usersRouter,
  platform: router({
    journal: journalRouter,
    identity: identityRouter,
  }),
});

export type AppRouter = typeof appRouter;
