# @repo/api

Hono + tRPC + Better Auth. The API **mounts** the router from `@repo/trpc` — it
does not define procedures.

## Layout

- `src/index.ts` — Hono app. Middleware order: `requestId()` → `@hono/otel` →
  request logging → CORS (reflect origin, credentials). Mounts Better Auth at
  `/api/auth/**`; a session middleware on `/trpc/*` sets `user`/`session`; tRPC
  mounted via `@hono/trpc-server`. `createContext` injects `db`, `logger`, email/
  sms senders, and an in-memory rate limiter. Health check at `/`.
  Exports `app` for tests; only calls `serve()` when `VITEST` is unset.
- `src/lib/auth.ts` — `betterAuth({ database: pool })` (core plan 03, ADR-0014).
  SSO + OTP only (password removed): Entra ID (Microsoft social provider) for
  employees + `emailOTP` (6-digit/300s, `disableSignUp: true` — invitation-only,
  PL-036) + `admin` + `customSession` (adds `personId`). DB-backed `rateLimit`
  - Turnstile `captcha` on OTP send (PL-044). `databaseHooks` attach a
    `platform.person` on first Entra sign-in and journal `signed_in`. The Entra
    provider and captcha ship **inert** until `ENTRA_CLIENT_SECRET` /
    `TURNSTILE_SECRET_KEY` are set. Better Auth tables are reached only via
    `@repo/identity` (the adapter boundary).
- `src/instrument.ts` — OTel init (imported via `--import`).
- `src/logger.ts` — Winston logger via `@repo/logging`.

## Build/run

- dev: `tsx watch --conditions=development --import ./src/instrument.ts`.
- build: `tsup` (entries `index.ts` + `instrument.ts`, ESM, node24,
  `createRequire` banner). start: `node --import ./dist/instrument.js`.
- Tests: `src/__tests__/` via `app.request()` (no HTTP server).

Env via `@repo/env` `parse()` only. Never `process.env`, never `console.log`.
