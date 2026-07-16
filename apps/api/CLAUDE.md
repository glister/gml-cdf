# @repo/api

Hono + tRPC + Better Auth. The API **mounts** the router from `@repo/trpc` — it
does not define procedures.

## Layout

- `src/index.ts` — Hono app. Middleware order: `requestId()` → `@hono/otel` →
  request logging → CORS (reflect origin, credentials). Mounts Better Auth at
  `/api/auth/**`; a session middleware on `/trpc/*` sets `user`/`session`; tRPC
  mounted via `@hono/trpc-server`. `createContext` injects `db`, `logger`, email/
  sms senders, an in-memory rate limiter, and `isServiceCall` (timing-safe
  compare of `x-service-token` vs `INTERNAL_SERVICE_TOKEN`). Health check at `/`.
  Exports `app` for tests; only calls `serve()` when `VITEST` is unset.
- `src/lib/auth.ts` — `betterAuth({ database: pool })`. Email/password +
  `emailOTP` (6-digit/300s, sends via `@repo/email`) + `admin` (roles
  admin/agent, `defaultRole: 'agent'`) + `customSession`. Snake_case column
  mapping per model + admin plugin `schema`. No social provider.
- `src/instrument.ts` — OTel init (imported via `--import`).
- `src/logger.ts` — Winston logger via `@repo/logging`.

## Build/run

- dev: `tsx watch --conditions=development --import ./src/instrument.ts`.
- build: `tsup` (entries `index.ts` + `instrument.ts`, ESM, node24,
  `createRequire` banner). start: `node --import ./dist/instrument.js`.
- Tests: `src/__tests__/` via `app.request()` (no HTTP server).

Env via `@repo/env` `parse()` only. Never `process.env`, never `console.log`.
