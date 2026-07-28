/* eslint-disable @repo/no-process-env -- E2E tooling; targets are chosen by the
   runner via env, not @repo/env. */
import type { APIRequestContext } from '@playwright/test';

// Auth lives on the api app; Mailpit captures the OTP. Defaults suit native
// `pnpm dev`; point these at the running stack (e.g. Docker) to run the
// authenticated specs. This drives the HTTP API directly, so it never touches the
// login form or its Turnstile widget (a client-side gate the API path doesn't hit).
const API = process.env.E2E_API_URL ?? 'http://localhost:3001';
const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@cdf.local';

/**
 * Sign in as the seeded admin by completing the email-OTP flow against the API,
 * using the browser context's own request object so the session cookie lands in
 * the shared cookie jar — subsequent `page.goto()` calls are authenticated.
 */
export async function signInAsAdmin(request: APIRequestContext): Promise<void> {
  // A stable, dedicated client IP so the OTP-send rate-limit bucket is the E2E's
  // own (one send per run) and not shared with ad-hoc local requests.
  const ipHeaders = { 'x-forwarded-for': '198.51.100.77' };
  await request.delete(`${MAILPIT}/api/v1/messages`);
  const send = await request.post(`${API}/api/auth/email-otp/send-verification-otp`, {
    headers: ipHeaders,
    data: { email: ADMIN_EMAIL, type: 'sign-in' },
  });
  if (!send.ok()) throw new Error(`OTP send failed (${send.status()}) — is the stack up?`);

  let otp: string | undefined;
  for (let i = 0; i < 20 && !otp; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const list = (await (await request.get(`${MAILPIT}/api/v1/messages?limit=1`)).json()) as {
      messages?: { ID: string }[];
    };
    const id = list.messages?.[0]?.ID;
    if (!id) continue;
    const msg = (await (await request.get(`${MAILPIT}/api/v1/message/${id}`)).json()) as {
      Text?: string;
    };
    otp = msg.Text?.match(/\b\d{6}\b/)?.[0];
  }
  if (!otp) throw new Error('No OTP received via Mailpit (check E2E_MAILPIT_URL).');

  const verify = await request.post(`${API}/api/auth/sign-in/email-otp`, {
    headers: ipHeaders,
    data: { email: ADMIN_EMAIL, otp },
  });
  if (!verify.ok()) throw new Error(`OTP verify failed (${verify.status()}).`);
}
