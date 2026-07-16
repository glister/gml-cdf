import { router } from './trpc.js';
import { usersRouter } from './routers/users.js';

/**
 * Composition root: merge every feature router from `./routers/*` here.
 */
export const appRouter = router({
  users: usersRouter,
});

export type AppRouter = typeof appRouter;
