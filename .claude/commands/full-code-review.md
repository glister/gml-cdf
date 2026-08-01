---
description: Thorough whole-app code-quality review of the cdf-connect, with prioritised findings and fixes
argument-hint: [optional scope, e.g. "packages/trpc" or "apps/web routes"]
---

You are running `/full-code-review` — a **code-quality review of the whole
cdf-connect application** (or the scope named here: **$1** — if empty, review
the entire app).

This is an engineering-quality audit, not a security review (that's
`/full-security-review`) and not a bug hunt. You are judging whether the code is
well-structured, follows this repo's own rules, will be cheap to change, and
will not rot. The guiding principle is the one in the root `CLAUDE.md`: _"This
codebase will outlive you… leave it better than you found it."_ Measure the code
against that.

Report real, actionable findings. A vague "consider refactoring" helps nobody —
name the class, the duplication, the missing index, and the change. Do not pad
the list with taste-based nits; rank by how much future pain each item causes.

## How to work

1. **Load the rulebook first.** This repo documents its conventions — a finding
   is strongest when it cites the rule being broken. Read:
   - Root `CLAUDE.md` (tech stack, package kinds, coding guidelines, the web
     data/tables/forms hard rules, data conventions).
   - The per-package `CLAUDE.md` in every package/app you review
     (`packages/*/CLAUDE.md`, `apps/*/CLAUDE.md`).
   - `docs/adr/*` — especially ADR-0008 (module boundaries), ADR-0009
     (separation of data/logic/orchestration), ADR-0010/0011/0012 (event
     journal, table conventions, history), ADR-0016 (reference data & config),
     ADR-0021/0022 (event grammar, single write paths).
   - `turbo.json`, `eslint.config.js`, `packages/eslint-config/rules/*`,
     `packages/db/.kysely-codegenrc.json`.
2. **Survey structure, then read deeply.** Get file sizes and shapes first
   (`wc -l` across `packages/*/src` and `apps/*/src`) to spot god modules, then
   read the largest and most central files (`packages/trpc/src/router.ts`,
   `routers/*`, `schemas.ts`, the web `routes/*` and `components/*`, the worker
   handlers).
3. **Verify claims against the code.** A CLAUDE.md rule is the intended state,
   not proof — confirm it holds by reading and grepping. Note where reality has
   drifted from the documented convention.
4. **Judge the trend, not just the snapshot.** The app is early (few routers so
   far). Flag patterns that are fine at N=1 but will be copied into disasters at
   N=30 — the corners cut here get cut again everywhere.

## What to check — dimensions for THIS stack

### Following the repo's guidelines & library choices

The repo mandates specific libraries and patterns; hand-rolled alternatives are
findings.

- **Web data/tables/forms (hard rules).** All server state via TanStack Query
  (`trpcReact` hooks) — grep for bare `fetch`/`useEffect` data fetching or
  `useState` server-state caches. All lists via TanStack Table in manual mode —
  grep for `.map()` over `<tr>` with bespoke sort/filter state. All forms via
  TanStack Form + shared Zod schemas — grep for raw `useState` + `onSubmit`
  forms. Route guards are UX-only; authz lives in procedures.
- **No `process.env`** — must go through `@repo/env` `parse()`/`safeParse()`
  (enforced by the `no-process-env` rule; check it isn't disabled). Client code
  uses `import.meta.env` with `VITE_` prefixes.
- **No `console.log`** — log via `@repo/logging` (`no-console`); standalone CLI
  scripts (migrations/seed) are the documented exception.
- **ESM correctness** — `.js` extensions in relative imports for tsc/tsup code;
  `"type": "module"` everywhere. Grep for extensionless relative imports.
- **Generated files never hand-edited** — `apps/web/src/routeTree.gen.ts` and
  `packages/db/src/types.ts`. Grep git/diff for manual edits.

### Separation of concerns & module boundaries (ADR-0008/0009)

- **Apps never import other apps**; shared code lives in `packages/*`. Grep app
  imports for cross-app references.
- **`@repo/trpc` owns the API contract** — procedures and Zod schemas defined
  there, `apps/api` only mounts the router. Flag any procedure logic or schema
  leaking into `apps/api`.
- **Data / business-logic / orchestration cleanly separated** (ADR-0009). Flag
  procedures that inline heavy domain logic that belongs in a `@repo/domain`-style
  pure function, and SQL scattered where a shared query helper should exist.
- **New shared functionality belongs in a package** — if both apps need it, it's
  a package (source-only unless a compiled artifact is genuinely needed). Flag
  duplicated helpers that should be extracted; flag premature packages too.

### God classes / oversized modules & abstraction quality

- **God modules/functions** — flag files or functions doing too many unrelated
  things (a router file mixing many domains, a component handling fetch +
  transform + render + mutation, a function with many responsibilities/deep
  nesting/high branching). Suggest the split.
- **Under- and over-abstraction** — call out both: copy-paste that should be one
  helper, _and_ speculative generality / indirection that adds no value (a
  one-caller "framework", a wrapper that only forwards). The bar is "does this
  abstraction pay for its complexity."
- **Reusability / DRY** — duplicated query shapes, validation, formatting,
  keyset wiring. Point to the canonical version to reuse
  (`packages/trpc/src/lib/keyset.ts` for pagination,
  `packages/trpc/src/routers/users.ts` as the reference router,
  `packages/db/src/test-support.ts` for test factories).

### Typing quality

- **Minimal/zero `any`** — grep for `: any`, `as any`, `<any>`, `as unknown as`,
  `@ts-expect-error`/`@ts-ignore`, non-null `!` assertions, and
  `Kysely<any>`. Each is a finding unless justified with a comment explaining
  why no safe type exists; the `@hono/trpc-server` context cast in
  `apps/api/src/index.ts` is the documented, acceptable kind of exception —
  hold others to that standard.
- **Strict-null discipline** — no defensive `?.` chains masking a modelling
  problem; nullability reflected in types, not asserted away.
- **DB record types** — use Kysely `Selectable`/`Insertable`/`Updateable` (and
  the `XxxRecord`/`NewXxx`/`XxxUpdate` aliases from `@repo/db`), never inline
  anonymous record types.
- **Schema-typed boundaries** — tRPC procedures validate inputs with shared Zod
  schemas from `schemas.ts` and set `.output()` schemas where shape matters;
  the web reuses those inferred types rather than re-declaring shapes.

### Data model quality

- **Table conventions (ADR-0011)** — every app table has UUIDv7 app-side PK,
  `created_at`/`updated_at`/`deleted_at`, actor columns; history per class
  (ADR-0012). Flag tables missing these.
- **String-literal-union columns** — any column constrained to a fixed set
  (`CHECK (col IN (...))` or a Zod enum) MUST have a matching override in
  `packages/db/.kysely-codegenrc.json` (`overrides.columns`, literals inlined,
  never imported from `@repo/trpc`) so the generated type is the union, not bare
  `string`, followed by `pnpm --filter @repo/db migrate:generate`. Cross-check
  every enum/CHECK column against the codegenrc — a missing entry is a finding
  (the type silently degrades to `string`).
- **Normalisation & derived data** — no duplicated source-of-truth columns;
  derived/status values computed in SQL (CASE/CTE) so filter, sort and display
  read the same expression (per the data-tables rule), not stored redundantly or
  computed client-side.
- **Event/ledger modelling** — balances/history derived from append-only events
  (ADR-0010), never a mutable total; mutations through the single write path
  (ADR-0022); event payloads PII-minimal (ADR-0019).

### Database indexes & query shape

- **Indexes** — for every migration, verify indexes exist for: foreign-key
  columns, columns used in `WHERE`/filter facets, the keyset **sort-key
  expression + id tiebreak** (a keyset page without a supporting index is a
  sequential scan at every page), and `UNIQUE` constraints for natural keys.
  Flag `deleted_at`-filtered hot paths that would benefit from a partial index.
  Read the migration files under `packages/db/src/migrations/*`.
- **Query efficiency** — grep for N+1 patterns (a query inside a `.map`/loop
  over rows), `selectAll()` where explicit columns are wanted, and — a repo hard
  rule — any client-side `.filter()`/`.sort()` over a fetched page instead of
  pushing the facet into SQL (this is both a correctness and a performance
  finding under keyset pagination).

### Testing quality

- **Inadequate coverage** — business logic, state transitions, entitlement/
  derivation, guards, and RBAC branches must be tested. Keyset/sort/filter
  correctness must be validated against **real Postgres** (page the whole set;
  assert global order, no duplicates, no gaps) — a mock-DB test does not prove
  it and must not be counted as coverage for it.
- **Pointless tests** — flag tests that assert nothing meaningful: trivial
  getters/pass-throughs, tests that re-assert the framework/library, tests
  mirroring the implementation so any change breaks them, snapshot tests over
  volatile output, and mock-DB tests that "prove" SQL correctness they cannot.
  Coverage is not the goal; every test must protect against a real regression.
- **Test hygiene** — tests use `@repo/vitest-config`; new env vars have a
  test-safe default in root `.env.test` (a missing default breaks suites
  monorepo-wide); factories from `@repo/db/test-support` rather than ad-hoc
  fixtures; API tests use Hono `app.request()`, web tests jsdom, E2E Playwright
  for integration-free core flows.

### Error handling, async & correctness hygiene

- **tRPC errors** — thrown as `TRPCError` with correct codes
  (`UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/`BAD_REQUEST`), not bare `throw`/
  swallowed catches; no error bodies leaking internals.
- **Async** — grep for floating promises (un-awaited async calls),
  `async` functions with no `await`, unhandled-rejection risks in the worker.
- **Dead code** — unused exports, commented-out blocks, TODO/FIXME left as
  landmines, config drift (an env var in `compose.yml` missing from
  `turbo.json` `globalEnv`, or vice versa).

### Consistency & readability

- **Match existing patterns** — new code should read like the code around it
  (naming, file layout, the reference router). Inconsistency is a finding
  because it multiplies as it's copied.
- **Comments** — per the repo rule, a comment states a constraint the code can't
  show; flag narration ("this loops over users"), attribution, and
  reviewer-directed comments as noise to remove.

## Output — a prioritised findings report

Produce a single markdown report. **Do not modify any code.** Structure:

1. **Summary** — one paragraph: overall code health, the recurring themes, and
   the highest-leverage improvement. Note what the codebase does _well_ (an
   honest review isn't only negative).
2. **Findings**, grouped by severity (**High → Medium → Low**), then by blast
   radius (how much code copies or depends on the pattern). Each finding:
   - **Title** — the issue and location in one line.
   - **Severity** — High (will cause real pain / breaks a hard rule / silent
     type or data degradation), Medium (clear improvement, contained), Low
     (polish). One-line rationale.
   - **Location** — `file:line` (clickable) and the relevant snippet.
   - **Problem** — what's wrong and why it costs later: the rule broken, the
     duplication, the missing index and the query that scans without it.
   - **Fix** — the specific change: the split, the extraction, the codegenrc
     entry, the migration `CREATE INDEX`, the type. Show corrected code where it
     clarifies, and point to the canonical repo pattern to follow.
   - **Confidence** — Confirmed (read the code) vs Needs verification (e.g. an
     index whose necessity depends on query volume) and how to confirm.
3. **Metrics appendix** — a short table: largest files by LOC, `any`/`as any`/
   `@ts-ignore` counts by package, routers/procedures without tests, enum/CHECK
   columns missing a codegenrc override, tables/migrations missing expected
   indexes. Numbers make the review auditable and trackable over time.
4. **What was reviewed** — surfaces/files covered and anything not reviewed, so
   no gap reads as "clean."

Rank ruthlessly and be concrete. If a dimension is genuinely clean, say so
briefly rather than inventing findings — a short, trusted review beats a long,
padded one.
