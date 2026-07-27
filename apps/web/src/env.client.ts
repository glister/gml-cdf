import { parse, z } from '@repo/env';

// Client env: read from Vite's import.meta.env (not process.env). Client vars
// must be VITE_-prefixed.
const schema = z.object({
  VITE_API_URL: z.string().min(1),
  // Cloudflare Turnstile public site key (PL-044). Optional: when unset the
  // bot-protection widget is not rendered and OTP send proceeds without a
  // captcha token — the server captcha plugin is likewise inert until its
  // secret is present, so the two stay in step.
  VITE_TURNSTILE_SITE_KEY: z.string().optional(),
});

export const clientEnv = parse(schema, import.meta.env);
