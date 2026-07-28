import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the OTPs Better Auth "emails" so the flow can complete in-process.
// Hoisted above the app import, so auth.ts's `createEmailClient()` gets this mock.
const otpSink = new Map<string, string>();
vi.mock('@repo/email', () => ({
  createEmailClient: () => ({
    sendOtp: async (to: string, code: string) => void otpSink.set(to.toLowerCase(), code),
    sendInvitation: async () => {},
  }),
}));

import { type NewPerson, db, newUuidV7 } from '@repo/db';
import { createMigrator, truncateAll } from '@repo/db/test-support';
import { provisionInvitedUser } from '@repo/identity';
import { app } from '../index.js';

/**
 * Auth-flow integration (core plan 03 §10): invitation-only OTP (PL-036), the
 * invited account resolving to its pre-linked person, and the OTP-send rate limit
 * (PL-044). Drives the Hono app in-process via `app.request()` against an isolated
 * Postgres. Captcha is blanked in this suite's env (see vitest.config) — it can't
 * be exercised without Cloudflare and is separate UAT.
 */

beforeAll(async () => {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await truncateAll(db);
  otpSink.clear();
});

// A trusted origin (BETTER_AUTH_TRUSTED_ORIGINS) + a stable client IP so the
// DB-backed rate limiter keys consistently across requests.
const headers = {
  'content-type': 'application/json',
  origin: 'http://localhost:17001',
  'x-forwarded-for': '203.0.113.7',
};
const post = (path: string, body: unknown) =>
  app.request(`/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

async function insertPerson(overrides: Partial<NewPerson> = {}): Promise<string> {
  const id = newUuidV7();
  await db
    .insertInto('platform.person')
    .values({ id, relationship_type: 'agency', display_name: 'External', ...overrides })
    .execute();
  return id;
}

const usersWithEmail = (email: string) =>
  db.selectFrom('user').select(['id', 'person_id']).where('email', '=', email).execute();

describe('invitation-only OTP (PL-036, AC-D10)', () => {
  it('refuses an OTP request for an uninvited email — no user, no person, no journal', async () => {
    // domain_event is append-only (truncateAll can't wipe it), so measure the
    // delta rather than an absolute count.
    const journalBefore = (await db.selectFrom('platform.domain_event').select('id').execute())
      .length;

    await post('/email-otp/send-verification-otp', {
      email: 'stranger@example.com',
      type: 'sign-in',
    });

    // disableSignUp: possession of the URL yields nothing — no account is created,
    // regardless of the (enumeration-safe) response shape.
    expect(await usersWithEmail('stranger@example.com')).toHaveLength(0);
    expect(await db.selectFrom('platform.person').select('id').execute()).toHaveLength(0);
    const journalAfter = (await db.selectFrom('platform.domain_event').select('id').execute())
      .length;
    expect(journalAfter).toBe(journalBefore);
  });

  it('an invited user completes OTP sign-in and resolves to the pre-linked person', async () => {
    const personId = await insertPerson();
    const email = 'invitee@example.com';
    await db.transaction().execute((trx) => provisionInvitedUser(trx, { personId, email }));

    const send = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    expect(send.status).toBe(200);
    const otp = otpSink.get(email);
    expect(otp).toMatch(/^\d{6}$/);

    const verify = await post('/sign-in/email-otp', { email, otp });
    expect(verify.status).toBe(200);

    // The signed-in credential resolves to the pre-linked person, and a session exists.
    const [user] = await usersWithEmail(email);
    expect(user?.person_id).toBe(personId);
    const sessions = await db
      .selectFrom('session')
      .select('id')
      .where('user_id', '=', user!.id)
      .execute();
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // A second sign-in reuses the same user — no duplicate account (PL-035).
    await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    await post('/sign-in/email-otp', { email, otp: otpSink.get(email) });
    expect(await usersWithEmail(email)).toHaveLength(1);
  });
});

describe('OTP send rate limit (PL-044)', () => {
  it('returns 429 once the send threshold (3 / window) is exceeded', async () => {
    const personId = await insertPerson();
    const email = 'ratelimit@example.com';
    await db.transaction().execute((trx) => provisionInvitedUser(trx, { personId, email }));

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
      statuses.push(res.status);
    }
    // Custom rule: max 3 per 600s on the OTP-send path (auth.ts).
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });
});
