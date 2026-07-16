import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { httpInstrumentationMiddleware } from '@hono/otel';
import { trpcServer } from '@hono/trpc-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { db } from '@repo/db';
import { createCloudStorage } from '@repo/cloud-storage';
import { createEmailClient } from '@repo/email';
import { createSmsClient } from '@repo/sms';
import { parse, z } from '@repo/env';
import { appRouter, type RateLimiter, type TRPCContext } from '@repo/trpc';
import { auth, type Session, type User } from './lib/auth.js';
import { logger } from './logger.js';

type Variables = {
  user: User | null;
  session: Session | null;
};

const env = parse(
  z.object({
    PORT_API: z.coerce.number().int().positive(),
    INTERNAL_SERVICE_TOKEN: z.string().min(1),
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

/** Timing-safe compare of the incoming service token against the secret. */
function isValidServiceToken(provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(env.INTERNAL_SERVICE_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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

// Resolve the session for tRPC (and any other protected routes).
app.use('/trpc/*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set('user', session?.user ?? null);
  c.set('session', session?.session ?? null);
  await next();
});

function buildContext(c: Context<{ Variables: Variables }>): TRPCContext {
  const user = c.get('user');
  const session = c.get('session');
  // The admin plugin adds `role` to the user; it isn't on the base inferred type.
  const role = (user as { role?: string | null } | null)?.role === 'admin' ? 'admin' : 'agent';
  return {
    db,
    logger,
    email,
    sms,
    rateLimit,
    isServiceCall: isValidServiceToken(c.req.header('x-service-token')),
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
