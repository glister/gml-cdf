# @repo/trpc

The API contract **and the security boundary**. Source-only, exports
`./src/index.ts`. The `appRouter` is defined HERE, not in `apps/api` — the API
only mounts it.

## Layout

- `src/trpc.ts` — init hub. `initTRPC.context<TRPCContext>()`; exports `router`
  and the procedure builders: `publicProcedure`, `protectedProcedure`,
  `adminProcedure`, `serviceProcedure`. `TRPCContext` carries injected `db`,
  `user`, `session`, `logger`, `email`, `sms`, `rateLimit`, `isServiceCall`.
  Services are passed in as structural interfaces — never imported here (keeps
  the package decoupled).
- `src/schemas.ts` — flat module of Zod input/output schemas + inferred types.
  Enums derive from constant tuples in `./lib/constants.ts`.
- `src/router.ts` — composition root; merges `./routers/*` into `appRouter`.
- `src/routers/*` — one file per domain; validators from `../schemas.js`, queries
  via `ctx.db`, helpers from `./lib`.
- `src/lib/keyset.ts` — cursor/keyset pagination helpers.

## Hard rule — server-side tables

All filtering/sorting/searching happens in SQL via keyset/cursor pagination —
never client-side over a loaded page. The SAME sort-key expression drives both
`ORDER BY` and the cursor boundary, coalesced non-null. Timestamp sort keys are
rendered as fixed-width text (`timestampSortKey`) to avoid ms truncation at page
edges. Push every facet into the input schema and apply as `where`/`order by`.

## Auth

Enforcement lives in the procedures (`protectedProcedure`/`adminProcedure`/
`serviceProcedure`), not in the app. Web-side route guards are UX-only.
