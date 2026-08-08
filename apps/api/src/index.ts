import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { httpInstrumentationMiddleware } from '@hono/otel';
import { trpcServer } from '@hono/trpc-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { db, newUuidV7 } from '@repo/db';
import { createCloudStorage } from '@repo/cloud-storage';
import { createEmailClient } from '@repo/email';
import { createSmsClient } from '@repo/sms';
import { parse, z } from '@repo/env';
import {
  appRouter,
  loadGrantsForPerson,
  type ContextGrant,
  type RateLimiter,
  type TRPCContext,
} from '@repo/trpc';
import { auth, type Session, type User } from './lib/auth.js';
import { documentRoutes } from './routes/documents.js';
import { logger } from './logger.js';

type Variables = {
  user: User | null;
  session: Session | null;
  personId: string | null;
  grants: ContextGrant[];
};

const env = parse(
  z.object({
    PORT_API: z.coerce.number().int().positive(),
    VITEST: z.string().optional(),
  }),
);

// Shared singletons injected into every tRPC context.
const email = createEmailClient({ logger });
const smsClient = createSmsClient({ logger });
const storage = createCloudStorage({ logger });

// Adapt the SmsClient (message-object API) to the trpc SmsSender (to, body).
const sms = {
  async send(to: string, body: string): Promise<void> {
    await smsClient.send({ to, body });
  },
};

/** Fixed-window in-memory rate limiter. */
function createRateLimiter(limit = 100, windowMs = 60_000): RateLimiter {
  const hits = new Map<string, { count: number; reset: number }>();
  return {
    check(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || now > entry.reset) {
        hits.set(key, { count: 1, reset: now + windowMs });
        return true;
      }
      if (entry.count >= limit) return false;
      entry.count += 1;
      return true;
    },
  };
}
const rateLimit = createRateLimiter();

/** Any RFC-4122 UUID shape (accepts an inbound correlation id from a caller). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The originating client address, as far as it can honestly be known.
 *
 * `x-forwarded-for` is a list, and the **first** entry is the client; the rest
 * are proxies. Trusting the last one would record our own ingress on every
 * signature. Falls back to the **socket** address, and finally to `null` rather
 * than to a placeholder — an unknown address recorded as `0.0.0.0` reads like a
 * fact, and this value ends up in a signature evidence pack.
 */
function clientIp(c: Context<{ Variables: Variables }>): string | null {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header('x-real-ip');
  if (real) return real;
  // No proxy in front (local dev, or a direct connection): the socket address is
  // the honest answer, and it is one we always have.
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

const app = new Hono<{ Variables: Variables }>();

app.use('*', requestId());
app.use('*', httpInstrumentationMiddleware({ serviceName: 'api' }));

// Request logging.
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  logger.info('request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - start,
    requestId: c.get('requestId'),
  });
});

// CORS: reflect the request origin, allow credentials.
app.use(
  '*',
  cors({
    origin: (origin) => origin,
    credentials: true,
  }),
);

// Better Auth routes.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Resolve the session for tRPC (and any other protected routes). The
// customSession plugin augments the payload with `personId` (the resolved
// platform.person), so no second query is needed for identity.
//
// Authorisation grants are loaded here too — one indexed query per authenticated
// request (core plan 04 §9.3). They are loaded unfiltered by time window on
// purpose: `roleProcedure` checks the window per call, so a grant expiring
// mid-session stops authorising without a re-login.
app.use('/trpc/*', async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  const personId = (result as { personId?: string | null } | null)?.personId ?? null;
  c.set('user', result?.user ?? null);
  c.set('session', result?.session ?? null);
  c.set('personId', personId);
  c.set('grants', await loadGrantsForPerson(db, personId));
  await next();
});

function buildContext(c: Context<{ Variables: Variables }>): TRPCContext {
  const user = c.get('user');
  const session = c.get('session');
  // The admin plugin adds `role` to the user; it isn't on the base inferred type.
  const role = (user as { role?: string | null } | null)?.role === 'admin' ? 'admin' : 'agent';
  // Accept a caller-supplied correlation id when it is a valid UUID, else mint
  // one per request (core plan 02).
  const inbound = c.req.header('x-correlation-id');
  const correlationId = inbound && UUID_RE.test(inbound) ? inbound : newUuidV7();
  return {
    db,
    logger,
    email,
    sms,
    rateLimit,
    correlationId,
    actorPersonId: c.get('personId') ?? null,
    grants: c.get('grants') ?? [],
    // The request's own facts, for SES evidence (core plan 11 §4.7, PL-011).
    // Taken here rather than accepted as an input: a client-supplied IP would be
    // evidence of what the client claimed, which is exactly what a repudiation
    // challenge attacks. `x-forwarded-for` is first because Container Apps
    // terminates TLS at an ingress — the socket address would be the proxy's.
    requestIp: clientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          role,
        }
      : null,
    session: session ? { id: session.id, userId: session.userId } : null,
  };
}

app.use(
  '/trpc/*',
  trpcServer({
    endpoint: '/trpc',
    router: appRouter,
    // @hono/trpc-server erases the context type (returns Record<string,unknown>);
    // the object is a real TRPCContext at runtime.
    createContext: (_opts, c) =>
      buildContext(c as Context<{ Variables: Variables }>) as unknown as Record<string, unknown>,
  }),
);

// Binary document routes (core plan 11 §5.1). Session-authenticated and
// record-scoped through the same helpers the tRPC router uses; they are Hono
// routes only because tRPC is a JSON transport and a PDF is not JSON.
app.use('/documents/*', async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  const personId = (result as { personId?: string | null } | null)?.personId ?? null;
  c.set('personId', personId);
  c.set('grants', await loadGrantsForPerson(db, personId));
  await next();
});
app.route('/', documentRoutes);

// Health check.
app.get('/', (c) => c.json({ status: 'ok' }));

// Keep `storage` referenced for wiring even though no route uses it yet.
export const services = { email, sms, storage };
export { app };

if (!env.VITEST) {
  serve({ fetch: app.fetch, port: env.PORT_API }, (info) => {
    logger.info(`api listening on :${info.port}`);
  });
}
