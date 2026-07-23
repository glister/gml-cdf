import { describe, expect, it } from 'vitest';
import { app } from '../index.js';

// Tests drive the Hono app in-process via `app.request()` — no HTTP server, no DB.

describe('health', () => {
  it('GET / returns ok', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('unknown route 404s', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
  });
});

describe('CORS', () => {
  it('reflects the request origin and allows credentials', async () => {
    const res = await app.request('/', {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});

describe('tRPC auth boundary', () => {
  it('rejects a protected procedure without a session (401)', async () => {
    // No auth cookie → getSession returns null → protectedProcedure throws
    // UNAUTHORIZED before any DB access.
    const res = await app.request('/trpc/users.list');
    expect(res.status).toBe(401);
  });

  it('rejects the admin-only journal pilot without a session (401)', async () => {
    // platform.journal.demoPing is an adminProcedure → the requireUser middleware
    // throws UNAUTHORIZED before any append (and before input parsing). A mutation
    // must be POSTed (a GET would 405 before reaching the auth guard). The
    // admin-permitted append→relay→consume path is proven end to end against the
    // running stack (core plan 02 T15), which the in-process app test can't
    // authenticate.
    const res = await app.request('/trpc/platform.journal.demoPing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'hi' }),
    });
    expect(res.status).toBe(401);
  });
});
