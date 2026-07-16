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
});
