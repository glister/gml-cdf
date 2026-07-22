# cdf-platform — monorepo guide

Turborepo + pnpm workspaces. ESM everywhere, TypeScript 5.8+ strict. Node 24
(via corepack). pnpm pinned through `packageManager`.

Each app and package also has its own `CLAUDE.md` with package-specific details.

## Tech Stack

- **Monorepo**: Turborepo with pnpm workspaces
- **Package Manager**: pnpm 11.10.0 (via corepack)
- **Language**: TypeScript 5.8+ (ESM throughout, `"type": "module"`)
- **Web App**: TanStack Start v1.168+ / TanStack Router / React 19 / Vite 7
- **Mobile App**: Expo SDK 57 / React Native / expo-router / NativeWind v4
  (ADR-0023); push via Expo Push (ADR-0024, trails in-app + email)
- **Data fetching**: TanStack Query v5 (via `@trpc/react-query`) — all
  server-state reads and mutations
- **Tables**: TanStack Table v8 — all paginated/list data
- **Forms**: TanStack Form v1 — all forms
- **UI**: Tailwind CSS v4 + shadcn/ui
- **Auth**: Better Auth (email/password + email OTP + admin roles, session cookies)
- **API App**: Hono / tRPC v11 / Winston
- **Worker**: Azure Service Bus consumer
- **Database**: PostgreSQL + Kysely (type-safe query builder)
- **Shared RPC**: tRPC v11 with Zod schemas in `packages/trpc`
- **Testing**: Vitest and Playwright
- **Linting**: ESLint 9 (flat config) + Prettier
- **Git Hooks**: Husky + lint-staged
- **Docker**: dev + production Dockerfiles in `docker/`

## Layout

- `apps/*` — deployable apps: `api` (Hono+tRPC+Better Auth), `web` (TanStack
  Start), `mobile` (Expo/React Native), `worker` (Service Bus consumer). Apps
  are never imported by other workspace members.
- `packages/*` — shared libraries and config.
- `docs/` — `docs/adr/` (architecture decision records) and
  `docs/plan/phase-01/` (the Phase 1 build contract: core, HR and mobile plan
  sets). Plan documents are the source of truth for feature work — implement
  them via `/implement-plan`.

## Design system

All UI work (web **and** mobile) follows the **CD Fencing Design System**, a
Claude Design project
([claude.ai/design](https://claude.ai/design/p/23b5e330-deb3-4365-8d26-171f9fcd95b1),
project id `23b5e330-deb3-4365-8d26-171f9fcd95b1`). It holds the design tokens
(`tokens/*.css`), brand/type/spacing/state guidelines, a per-domain component
library (prop contracts in `.d.ts`, usage notes in `.prompt.md`, reference
JSX) and full screen kits with desktop + mobile variants (`ui_kits/hr-app-*`).
Read it with the **DesignSync** tool (`list_files`/`get_file`; start with its
`SKILL.md`). Never invent styling or component patterns the system already
defines — match it, and flag genuine gaps rather than improvising.

## Commands

| Command             | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `pnpm dev`          | Start all apps via turbo (incl. the Expo dev server) |
| `pnpm build`        | Build all apps and packages                          |
| `pnpm lint`         | Lint all packages via turbo                          |
| `pnpm typecheck`    | Type-check all packages via turbo                    |
| `pnpm test`         | Run vitest in all packages via turbo                 |
| `pnpm format`       | Format all files with Prettier                       |
| `pnpm format:check` | Check formatting without writing                     |
| `pnpm migrate`      | Run DB migrations (`@repo/db`)                       |
| `pnpm seed`         | Seed the DB                                          |
| `docker compose up` | Start the dev environment in Docker                  |

Every task delegates to `turbo run <task>`. Filter to a single package with
`--filter`:

```
pnpm turbo build --filter=@repo/api
pnpm turbo test --filter=@repo/web
```

### Adding a dependency while the dev container is running

The host and the dev container keep separate `node_modules` trees (Linux vs.
macOS can't share one — native deps and pnpm layout diverge). The repo
(`package.json`, `pnpm-lock.yaml`, source) is bind-mounted in; only `node_modules`
is shadowed by container-owned volumes (see `compose.yml`).

When adding or upgrading a dependency, install on the host _and_ re-sync the
container:

```
pnpm add <pkg>                          # updates lockfile + host node_modules
docker compose exec dev pnpm install    # syncs container node_modules to the same lockfile
```

Skip the second step and the dev server inside the container won't see the new
package even though the lockfile already records it.

## Package kinds — source-only vs built

Know which category a package is in before editing it — the implications differ.

**Source-only** (no `build` script; `exports` → `./src/index.ts` directly):
`env`, `db`, `trpc`, `typescript-config`, `eslint-config`, `vitest-config`.

- Consumers import TypeScript source directly; their own bundler/compiler (tsup,
  Vite, tsx) handles it.
- Edits are picked up immediately in `pnpm dev` — no rebuild. `turbo build` skips
  them, so they add no `^build` wait for dependents.
- Imports still use `.js` extensions (ESM resolution rules apply in consumers).
- Do not add a `dist/` — the contract is "source is the entry point."

**Built** (`tsup` build; `exports` uses a `development` condition → source and a
default → `./dist`): `logging`, `email`, `sms`, `cloud-storage`, `service-bus`.

- In dev/typecheck/tests, Node/tsx resolves the `development` condition and reads
  TS source — edits are live, no rebuild.
- In production (`pnpm build`, built images) consumers resolve to
  `./dist/index.js`, so a rebuild is required. `turbo.json` handles this via
  `^build`; if you build a consumer without turbo, build its deps first.

Prefer source-only for new shared code unless a compiled artifact is genuinely
needed (consumption by a runtime without TS support, or a heavy transform worth
caching).

## Important files

- `turbo.json` — task pipelines. `build`/`lint`/`typecheck`/`test` depend on
  `^build`; `dev` is persistent and uncached. Every env var used across the repo
  is listed in `globalEnv`.
- `packages/trpc/src/router.ts` — **single source of truth for the API contract.**
  All tRPC procedures compose here, not in `apps/api`.
- `packages/trpc/src/schemas.ts` — all Zod input/output schemas, shared between
  client and server.
- `packages/trpc/src/lib/keyset.ts` — keyset/cursor pagination helpers
  (`timestampSortKey`, `keysetBoundary`, `encodeCursor`/`decodeCursor`).
- `apps/web/src/routeTree.gen.ts` — auto-generated by TanStack Router.
  **Never edit manually.**
- `apps/web/vite.config.ts` — plugin order matters: `env-check` → `tailwindcss()`
  → `tanstackStart()` → `tsconfigPaths()` → `react()`. `envDir` points at the
  repo root so the committed `.env`/`.env.test` are loaded.
- `apps/web/src/router.tsx` — must export `getRouter()` (not `createRouter`).
- `.husky/pre-commit` — runs lint-staged (eslint + prettier on staged files), then
  `pnpm ports:check`, `pnpm typecheck`, then `pnpm test`. When a
  `.github/workflows/*.yml` is staged,
  lint-staged also runs `pnpm lint:pins` and `pnpm lint:actions` (actionlint is an
  external binary — `brew install actionlint` — skipped gracefully if absent).

### GitHub Actions security

- **SHA-pin all third-party actions.** Every `uses:` for an external action must
  reference a full 40-char commit SHA (immutable), with the version as a trailing
  comment, e.g. `uses: actions/checkout@<sha> # v4.2.2`. Tags like `@v4` are
  mutable and a supply-chain risk. Local actions (`uses: ./...`) are exempt.
  Resolve a SHA with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`.
- **`pnpm lint:pins`** (`scripts/check-action-pins.sh`) enforces this —
  dependency-free, run in pre-commit and the `workflow-lint` CI gate.
- **Dependabot** (`.github/dependabot.yml`, `github-actions` ecosystem) opens
  weekly PRs bumping each SHA and its version comment.
- **`.github/workflows/workflow-lint.yml`** runs on PRs touching `.github/**`: pin
  check + actionlint + a [zizmor](https://docs.zizmor.sh) audit
  (`--min-severity=medium --offline`), all **blocking**. A legitimate finding is
  dismissed with a documented `# zizmor: ignore[<audit>]` comment.

## Coding Guidelines

This codebase will outlive you. Every shortcut becomes someone else's burden;
every hack compounds into technical debt. The patterns you establish will be
copied; the corners you cut will be cut again. **Leave the codebase better than
you found it.**

### General

- **ESM everywhere.** All packages use `"type": "module"`. Use `.js` extensions in
  relative imports for tsc/tsup-compiled code (`import { foo } from './bar.js'`).
- **Strict TypeScript.** All tsconfigs extend `@repo/typescript-config/base.json`
  (`strict`, `strictNullChecks`).
- **Never touch `process.env` directly.** Always use `parse()`/`safeParse()` from
  `@repo/env` with a local Zod schema — enforced by the `@repo/no-process-env`
  ESLint rule. Web client code passes `import.meta.env` with `VITE_`-prefixed
  vars; mobile client vars are `EXPO_PUBLIC_`-prefixed (single touch-point:
  `apps/mobile/src/env.ts`). No defaults for required vars — fail fast.
- **Never `console.log`** — log through `@repo/logging` (enforced by `no-console`;
  standalone CLI scripts opt out with an inline eslint-disable).
- **Shared config lives at the root.** There is one `eslint.config.js` and the
  shared `@repo/eslint-config`; packages run `eslint .` and resolve it upward. Test
  config extends `@repo/vitest-config`.
- **Reusable packages.** Use existing packages where appropriate; create a new one
  when functionality is shared across apps. If both apps need it, it belongs in a
  package.
- **Follow existing patterns.** If in doubt, match the conventions already in use.

### Testing

- **Test env defaults live in the root `.env.test`**, loaded automatically by
  `@repo/vitest-config`'s setup file. When adding a new env var anywhere you
  **must** also add a test-safe default here, or suites across the monorepo fail
  with Zod validation errors. Do not duplicate env values in individual
  `vitest.config.ts` files or mock `@repo/env` to work around a missing var.
- **Unit tests use Vitest.** API tests use Hono's `app.request()` (no HTTP
  server); web tests use jsdom.
- **Coverage is not the goal.** Test core functionality, business logic, and
  meaningful edge cases. No tests for trivial getters/pass-throughs/boilerplate —
  every test must protect against a real regression.
- **Negative paths.** Where coverage is warranted, include adversarial/extreme
  inputs to prove edge cases are handled gracefully.
- **E2E** uses Playwright's runner against a headless browser for core app flows
  that don't depend on third-party integrations.

### Monorepo conventions

- **`@repo/trpc` owns the API contract** — the security boundary. Procedures and
  schemas are defined there; `apps/api` mounts the router, `apps/web` consumes the
  types. All auth checks live in procedures (`protectedProcedure`,
  `adminProcedure`). Web-side route guards are UX-only.
- **Module schemas & boundaries (ADR-0008).** Every module table is
  schema-qualified (`platform.*`, `hr.*`; Better Auth stays in `public`). **A
  module never reads another module's tables** — cross-module access goes through
  the other module's exported service surface, and cross-module notification goes
  through domain events. Enforced two ways: ESLint blocks cross-module _imports_
  (`routers/hr/**` ↔ `routers/platform/**`) and apps being imported by packages;
  and — because ESLint cannot see SQL strings — **a `'platform.'`/`'hr.'` table
  key used outside its own module's directory is a review-blocking violation.**
- **`@repo/domain` is pure (ADR-0009).** All business-logic engines live there:
  no I/O, DB, env, clock or randomness (time and ids are passed in). Purity is
  lint-enforced. A tRPC procedure that grows business logic is a smell — move it
  to `@repo/domain`.
- **Package names use the `@repo/` scope.**

### Web data, tables and forms (hard rules)

These three are not preferences — they are the standard patterns every web
feature follows. Match the existing wiring; do not hand-roll alternatives.

- **All server state goes through TanStack Query.** Reads and mutations use the
  `trpcReact` hooks (`useQuery`/`useMutation`, `@trpc/react-query`) backed by the
  shared `QueryClient` (`src/query-client.ts`, in RouterContext). No bare
  `fetch`/`useEffect` data fetching and no ad-hoc `useState` server-state caches
  in components. Route loaders may use the vanilla `trpc` client, but anything
  reactive in a component is a Query hook.
- **All list/tabular data uses TanStack Table.** Any multi-row list rendered as a
  table is built with `@tanstack/react-table` (column defs + the headless model)
  in manual mode (`manualPagination`/`manualSorting`/`manualFiltering`) — never a
  bare `.map()` over `<tr>` with bespoke sort/filter state. The table renders one
  keyset page; filtering/sorting/pagination live server-side per the data-tables
  rule below.
- **All forms use TanStack Form.** Every form uses `useForm` from
  `@tanstack/react-form` with `form.Field` and `form.Subscribe`; validate with
  the shared Zod schemas from `@repo/trpc` via the standard-schema validator
  (`validators: { onChange: schema }`). No raw `useState` + `onSubmit` forms.

## Environment variables

### Non-sensitive

Ports, hostnames, etc. go in the root `.env` and are referenced in `compose.yml`
(as `environment`/`ports`) for the containers that need them. Host-published ports
are **not** hand-edited — they are derived from a single prefix (see "Port prefix
convention" below).

**IMPORTANT:** every env var defined for the `dev` service in `compose.yml` must be
listed in the `globalEnv` array in `turbo.json` (`pnpm ports:check` enforces this
for the managed `PORT_*` vars). All env vars used in client code MUST be
`VITE_`-prefixed (web) or `EXPO_PUBLIC_`-prefixed (mobile).

### Sensitive

API keys, tokens, certs, cloud creds do **not** go in `.env` — they go in the
git-ignored `.env.secrets` (you don't have access to it), exposed to containers via
compose `env_file`. Do not add secrets to `compose.yml`. When work needs a new
secret, report the variable to the user once complete.

### Ports — internal vs external

Services run in containers; the in-network port differs from the published one (the
mapping lives in `compose.yml` / `.env`). If a port feeds another env var used
**on the server**, use the internal port. If it feeds a var used **on the client**
(e.g. a `VITE_`- or `EXPO_PUBLIC_`-prefixed var), it MUST use the external port.

### Port prefix convention

Every **host-published** port derives from one prefix so projects don't clash on a
shared dev machine. The prefix lives in root `package.json` as `"portPrefix"` (this
repo: `170`); each project picks a distinct one. The formula and slot convention
(the last two digits — stable across all projects) are:

`external port = portPrefix * 100 + slot`. Bands: apps `00–09`, datastores /
messaging `10–19`, tooling / UI `20–29`.

| Slot | Service | @170 | | Slot | Service | @170 |
| ---- | ------------- | ----- | | ----- | ------------------ | ----- |
| 00 | web | 17000 | | 12 | servicebus (AMQP) | 17012 |
| 01 | api | 17001 | | 13 | azurite (blob) | 17013 |
| 02 | worker | 17002 | | 20 | mailpit SMTP | 17020 |
| 10 | postgres dev | 17010 | | 21 | mailpit UI | 17021 |
| 11 | postgres test | 17011 | | 22/23 | reserved (hyperdx) | — |

The real values are materialised as literals into `.env` / `.env.test` (dotenv
does not interpolate, and `compose.yml`, `psql`, migrations, and the env schemas
read the literals). **Never hand-edit a managed port.** Instead:

- `pnpm ports:sync` — rewrite `.env` / `.env.test` from the prefix.
- `pnpm ports:check` — verify no drift (runs in pre-commit and the `ports-check`
  CI gate; blocking).

Source of truth for the slot map + which vars each port drives (including ports
embedded inside URLs / connection strings) is `scripts/gen-ports.mjs`
(`SLOTS` / `FILES`). **Adding a service:** pick the next free slot in its band, add
it to `SLOTS` and the relevant `FILES` entries, add the `PORT_*` var to `.env` and
`turbo.json` `globalEnv`, then run `pnpm ports:sync`.

Only host-published ports are prefixed. **Container-internal ports stay fixed**
(`3000/3001/3002`, `5432`, `1025/8025`, `5672`, `10000`) — so the compose `dev`
in-network overrides, `API_INTERNAL_URL` (SSR → api's container `3001`), and `PORT`
(prod Node listen) are deliberately unmanaged. Changing the prefix moves the whole
stack; run `docker compose up` (native non-Docker `pnpm dev` is out of scope).

## Data

- **Foundations helpers & conventions (ADR-0011/0012/0004).** The shared table
  substrate lives in `@repo/db/migration-helpers` (`withStandardColumns`,
  `makeAppendOnly`, `attachUpdatedAtTrigger`) and `@repo/db` (`newUuidV7`). Before
  designing any table, classify it against the **history-mechanism checklist**
  and follow the append-only / soft-delete / UUIDv7 rules — all documented in
  `packages/db/CLAUDE.md` ("Foundations conventions"). Primary keys are app-side
  UUIDv7 (`uuid` columns, no DB default); append-only tables (journal, ledgers,
  transitions, evidence) use `makeAppendOnly`.
- **Timestamps.** Data records carry `created_at`, `updated_at`, `deleted_at`
  (via `withStandardColumns`; `updated_at` is trigger-maintained, `deleted_at` is
  soft-delete only — hard deletes are reserved for the plan 16 erasure process).
- **ORM records.** Use Kysely `Selectable`/`Insertable`/`Updateable` wrappers — no
  inline anonymous record types.
- **String-literal union columns.** Whenever a migration adds/changes a column
  constrained to a fixed set of strings (`CHECK (col IN (...))` or a matching Zod
  enum in `@repo/trpc/schemas.ts`), add/update its entry in
  `packages/db/.kysely-codegenrc.json` (`overrides.columns`) so the generated type
  is the literal union, not bare `string` (kysely-codegen otherwise collapses it).
  Inline the literals — never import from `@repo/trpc` (circular). Then regenerate
  via `pnpm --filter @repo/db migrate:generate`.

### Data tables (filtering, sorting, searching)

**Filtering, sorting, and searching of paginated tables MUST always happen
server-side, in SQL — never client-side over the loaded page.** Tables use
keyset/cursor pagination, so the client only holds one page; filtering/sorting in JS
would silently operate on that partial page and produce wrong, non-deterministic
results. Hard rule, not a preference.

- **Push every facet into the query.** Add the parameter to the tRPC input schema
  in `@repo/trpc/schemas.ts` and apply it as a `where`/`order by` in the procedure.
  The web layer only collects intent and passes it on — no post-fetch
  `.filter()`/`.sort()` on rows (client-side _formatting_ of an already-correct row
  is fine; reordering/dropping is not).
- **Derived columns belong in SQL.** Compute status/health/derived values in SQL
  (CASE/CTE/subquery) so the displayed value, the filter, and any aggregate read the
  same expression. If a derived column isn't worth expressing in SQL, remove the
  ability to filter/sort on it rather than faking it client-side.
- **Keyset sorting uses one expression for both `ORDER BY` and the cursor
  boundary**, coalesced non-null for a strict total order (plain `</>` + an `id`
  tiebreak). Render timestamp sort keys as fixed-width text (`timestampSortKey` /
  `to_char`) — a JS `Date` holds only ms precision, so round-tripping a microsecond
  Postgres timestamp through the cursor truncates the boundary and drops/duplicates
  rows at page edges. Helpers: `packages/trpc/src/lib/keyset.ts`; canonical pattern:
  `packages/trpc/src/routers/users.ts`.
- **Validate against a real database.** Mock-DB unit tests don't execute SQL, so
  keyset/sort/filter correctness can't be proven by them alone — exercise the
  procedure against the live/test Postgres (page the whole set; assert correct
  global order, no duplicates, no gaps).

## Local Postgres access

Use `psql -h localhost -p <PORT> -d <DB> -c "..."` for queries; credentials are in
`~/.pgpass` so no user/password flags are needed. Use `--csv` for parseable output.
Read-only unless told otherwise. `PORT` is `POSTGRES_PORT` in `.env` (dev `5432`,
test `5433`).

## Env files

- `.env` — committed non-secret dev config.
- `.env.test` — committed test-safe defaults (keep in sync with every new var).
- `.env.secrets` — git-ignored real secrets, loaded into containers via compose.

## Visual verification with agent-browser

When making UI changes, take a screenshot to verify your work looks correct before considering the task done. Use `agent-browser` (already installed globally).

### Basic screenshot workflow

Screenshots use a persistent authenticated session named `dev`. Always use `--session dev` so cookies persist between commands.

```bash
agent-browser --session dev open http://localhost:3000/some/route
agent-browser --session dev screenshot .screenshots/some-route.png --viewport 1280x800
```

For mobile checks, use `--viewport 375x812`. For full-page (scrolling) shots, add `--full-page`.

Save all screenshots to `.screenshots/` (gitignored). Use descriptive filenames like `dashboard-after-fix.png`, not `test.png`.

### After taking a screenshot

Read it back with the Read tool and check that the change you made is actually visible and correct. If it looks wrong, iterate. Do not mark a UI task complete without visually confirming.

### Handling expired auth

If a screenshot shows the login page (`/login`) instead of the expected authenticated content, the dev session has expired. Refresh it and retake the shot:

```bash
./scripts/refresh-auth.sh
```

The script uses Mailpit to intercept the OTP email and completes the sign-in flow automatically. It takes a few seconds. After it succeeds, retake the screenshot with the same `agent-browser --session dev` command.

Do not attempt to fill in the login form manually. Do not attempt to bypass authentication. Always use the refresh script.

### If refresh-auth.sh fails

- Check that the dev server is running on the expected port
- Check that Mailpit is running (default: `http://localhost:8025`)
- Check the login form selectors in the script match the current UI — if the login form was recently changed, the script's `fill` selectors may need updating

### When NOT to screenshot

- Backend-only changes (API routes, DB migrations, non-UI logic)
- Small refactors with no visual output
- Text-only changes (copy edits are fine to verify via code diff)

Screenshotting has a cost — do it when it adds real signal, not reflexively.
