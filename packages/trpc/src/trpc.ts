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
  sendInvitation(to: string): Promise<void>;
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
  rateLimit: RateLimiter;
  /**
   * Correlation id for this request (core plan 02, ADR-0010). Every event a
   * request appends via `appendEvent` carries it, so a user action and its
   * cascade share one id. Accepted from a valid `x-correlation-id` header, else
   * minted per request.
   */
  correlationId: string;
  /**
   * The acting person's id, or `null` for system/service calls. Resolved from
   * the session user's `person_id` link once plan 03 lands; `null` until then.
   */
  actorPersonId: string | null;
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
