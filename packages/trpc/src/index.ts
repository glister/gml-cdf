export { appRouter } from './router.js';
export type { AppRouter } from './router.js';

export {
  router,
  middleware,
  mergeRouters,
  publicProcedure,
  protectedProcedure,
  adminProcedure,
  roleProcedure,
} from './trpc.js';
export type {
  TRPCContext,
  ContextGrant,
  ContextUser,
  ContextSession,
  ContextLogger,
  EmailSender,
  SmsSender,
  RateLimiter,
} from './trpc.js';

/**
 * The task engine's workflow effects (core plan 08 §9.6).
 *
 * Exported for its **module-load side effects** as much as for the names: the
 * `tasks.*` handlers and the pilot subject loader register when this module is
 * loaded, so any consumer of `@repo/trpc` — the API, which executes transitions,
 * and the worker, which also dispatches their effects — sees one registry.
 */
export {
  openGateEffect,
  raiseTaskListEffect,
  recomputeDueDatesEffect,
  TASK_EFFECTS,
} from './lib/task-effects.js';

/** The task engine's transactional services (core plan 08 §5.1). */
export {
  cancelTask,
  claimTask,
  completeTask,
  openGate,
  raiseTaskList,
  recomputeDueDates,
  releaseTask,
  TaskForbiddenError,
  TaskNotFoundError,
  TaskSpecError,
  type TaskListItem,
} from './lib/tasks.js';

/** Grant resolution for the API context factory (core plan 04 §9.3). */
export { loadGrantsForPerson } from './lib/grants-context.js';

/**
 * The configuration store (core plan 06): the key registry and the as-at
 * resolution API. It now lives in its own source-only `@repo/config` — core plan
 * 07's runtime needs it and `@repo/trpc` imports that runtime, so keeping it
 * here made the two packages mutually dependent (core 07 §5.2 write-back,
 * 2026-08-05).
 *
 * Re-exported unchanged from the package root, so `apps/api`, `apps/worker` and
 * later plans' service code still resolve `config:` values from one place, the
 * web editor still validates against the very same Zod schemas, and no call site
 * had to move.
 */
export * from '@repo/config';

export * from './schemas.js';
export * from './lib/keyset.js';
export * from './lib/constants.js';
export * from './lib/scope.js';
export * from './lib/field-classification.js';
export * from './lib/special-category-journal.js';
