import { initTRPC, TRPCError } from '@trpc/server';
import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';
import type { UserRole } from './lib/constants.js';

/**
 * The tRPC init hub and the security boundary for the whole app. The router is
 * defined HERE (in `@repo/trpc`), not in `apps/api` — the API only mounts it.
 *
 * The package stays decoupled from concrete services: email/sms/logging are
 * passed in via the context as structural interfaces, never imported here.
 */

export interface ContextLogger {
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
  debug(message: string, ...meta: unknown[]): void;
}

export interface EmailSender {
  sendOtp(to: string, code: string): Promise<void>;
}

export interface SmsSender {
  send(to: string, body: string): Promise<void>;
}

export interface ContextUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface ContextSession {
  id: string;
  userId: string;
}

/** Simple in-memory rate limiter interface. `check` returns false when limited. */
export interface RateLimiter {
  check(key: string): boolean;
}

export interface TRPCContext {
  db: Kysely<DB>;
  user: ContextUser | null;
  session: ContextSession | null;
  logger: ContextLogger;
  email: EmailSender;
  sms: SmsSender;
  /** True when the request carried a valid internal service token. */
  isServiceCall: boolean;
  rateLimit: RateLimiter;
}

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const middleware = t.middleware;
export const mergeRouters = t.mergeRouters;

/** Open to anyone. */
export const publicProcedure = t.procedure;

const requireUser = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  // Narrow user/session to non-null for downstream procedures.
  return next({ ctx: { ...ctx, user: ctx.user, session: ctx.session } });
});

/** Requires an authenticated user. */
export const protectedProcedure = t.procedure.use(requireUser);

/** Requires an authenticated user with the `admin` role. */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin role required' });
  }
  return next({ ctx });
});

const requireService = t.middleware(({ ctx, next }) => {
  if (!ctx.isServiceCall) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Valid service token required' });
  }
  return next({ ctx });
});

/** Requires a valid internal service token (service-to-service calls). */
export const serviceProcedure = t.procedure.use(requireService);
