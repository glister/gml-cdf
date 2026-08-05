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

/** Grant resolution for the API context factory (core plan 04 §9.3). */
export { loadGrantsForPerson } from './lib/grants-context.js';

/**
 * The configuration store (core plan 06): the key registry and the as-at
 * resolution API. Exported from the package root so `apps/api`, `apps/worker`
 * and later plans' service code resolve `config:` values from one place, and the
 * web editor validates against the very same Zod schemas.
 */
export * from './config/index.js';

export * from './schemas.js';
export * from './lib/keyset.js';
export * from './lib/constants.js';
export * from './lib/scope.js';
export * from './lib/field-classification.js';
