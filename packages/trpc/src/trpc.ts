import { initTRPC, TRPCError } from '@trpc/server';
import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';
import { hasRole } from '@repo/domain';
import type { ModuleKey, RoleKey, UserRole } from './lib/constants.js';

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
   * the session user's `person_id` link (plan 03).
   */
  actorPersonId: string | null;
  /**
   * The acting person's live role grants — unrevoked, undeleted rows, loaded
   * once per request by the API context factory (core plan 04).
   *
   * "Live" here means only that the row has not been revoked or soft-deleted.
   * The **time window is deliberately NOT filtered here**: it is evaluated per
   * call by `roleProcedure`, so a grant that expires mid-session stops
   * authorising without the session being restarted (§5.1).
   */
  grants: ContextGrant[];
}

/**
 * One live grant as carried on the request context. Structurally a
 * `@repo/domain` `Grant`, so the pure engine consumes it directly.
 */
export interface ContextGrant {
  roleKey: RoleKey;
  module: ModuleKey;
  validFrom: Date;
  validUntil: Date | null;
  revokedAt: Date | null;
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

/**
 * Requires an authenticated user with Better Auth's `admin` role.
 *
 * **Framework operations only** (core plan 04 Q1, resolved 2026-07-28): user
 * bans, impersonation, Better Auth role assignment — the things the auth
 * framework itself governs. Every *product* surface authorises with
 * `roleProcedure` against `platform.role_grant`. Guarding a product procedure
 * with this builder is a review-blocking violation: it would resurrect a second,
 * parallel authorisation system (§12.3 risk).
 */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin role required' });
  }
  return next({ ctx });
});

/**
 * The domain authorisation builder (core plan 04 §5.1, PL-002): admits a caller
 * holding **any** of `roles`, active **now**, in **exactly** `opts.module`.
 *
 * Three properties are deliberate:
 *
 * 1. **`module` is mandatory and matched exactly.** There is no wildcard — a
 *    grant in `platform` does not satisfy `hr.er`, and a grant in
 *    `hr.holiday_leave` does not satisfy `platform` (Q5, resolved 2026-07-28).
 *    Without this the column would be documentation rather than enforcement.
 * 2. **The time window is evaluated per call**, not at context creation, so an
 *    expiring grant stops working without a restart (PL-042 substrate).
 * 3. **No implicit superuser.** `administrator` gets no hardcoded bypass; it is
 *    granted per module like any role, so every decision is explainable from
 *    `role_grant` rows (§4.1).
 *
 * Usage: `roleProcedure(['hr_user', 'administrator'], { module: 'hr.core' })`.
 */
export function roleProcedure(roles: readonly RoleKey[], opts: { module: ModuleKey }) {
  return protectedProcedure.use(({ ctx, next }) => {
    const actorPersonId = ctx.actorPersonId;
    if (!actorPersonId) {
      // Authenticated, but the login is not linked to a person record — so
      // there is nothing for a grant to attach to. Holding a login is identity,
      // not access (§4.1).
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'The acting user is not linked to a person record',
      });
    }
    if (!hasRole(ctx.grants, roles, opts.module, new Date())) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Requires one of [${roles.join(', ')}] in module '${opts.module}'`,
      });
    }
    // Narrow actorPersonId to non-null for downstream procedures.
    return next({ ctx: { ...ctx, actorPersonId } });
  });
}
