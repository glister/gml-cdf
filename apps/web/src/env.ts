import { parse, z } from '@repo/env';

// Isomorphic public env: read from Vite's import.meta.env (not process.env).
// These VITE_-prefixed vars are inlined at build time into BOTH the client and
// SSR bundles, so this module is safe to import from server-reachable code
// (routes, loaders) — hence `env.ts`, not `env.client.ts` (which TanStack Start's
// import-protection would forbid in the server environment). Server-only secrets
// live in the protected `env.server.ts`.
const schema = z.object({
  VITE_API_URL: z.string().min(1),
  // Cloudflare Turnstile public site key (PL-044). Optional: when unset the
  // bot-protection widget is not rendered and OTP send proceeds without a
  // captcha token — the server captcha plugin is likewise inert until its
  // secret is present, so the two stay in step.
  VITE_TURNSTILE_SITE_KEY: z.string().optional(),
});

export const clientEnv = parse(schema, import.meta.env);
