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

export * from './schemas.js';
export * from './lib/keyset.js';
export * from './lib/constants.js';
export * from './lib/scope.js';
export * from './lib/field-classification.js';
