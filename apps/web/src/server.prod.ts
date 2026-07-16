import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getServerEnv } from './env.server.js';
import { logger } from './logger.js';

/**
 * Production Node server: serves the vite client build from `dist/client` and
 * falls through to the SSR handler for everything else. Listens on PORT.
 */
const app = new Hono();

app.use('/assets/*', serveStatic({ root: './dist/client' }));
app.use('/favicon.ico', serveStatic({ path: './dist/client/favicon.ico' }));

app.all('*', async (c) => {
  // @ts-expect-error — emitted by the vite SSR build at runtime, not present at typecheck.
  const mod = await import('./server/entry-server.js');
  const handler = mod.default as { fetch: (request: Request) => Promise<Response> };
  return handler.fetch(c.req.raw);
});

const { PORT } = getServerEnv();
serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info(`web listening on :${info.port}`);
});
