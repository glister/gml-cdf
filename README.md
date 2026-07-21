# cdf-platform

A TypeScript monorepo (Turborepo + pnpm workspaces) with a Hono/tRPC API, a
TanStack Start web app, and an Azure Service Bus worker. Everything is ESM and
strictly typed.

## Prerequisites

- **Docker** — the only hard requirement to boot the stack. Runs local Postgres,
  the Azure emulators (Service Bus, Azurite), Mailpit, and the dev app container.
- **Node v24+ / pnpm v11+ on the host** — needed only for host-run commands
  (`pnpm migrate`/`pnpm seed`) and the git hooks (which run `pnpm` on commit), not
  for `docker compose up`. Enable with `corepack enable`, which installs the pnpm
  version pinned through `packageManager`. There is no `.nvmrc` and no `engines`
  field; Node 24 is assumed via corepack.

## Project structure

```
.
├── apps/
│   ├── api/          @repo/api    — Hono + tRPC + Better Auth
│   ├── web/          @repo/web    — TanStack Start + React 19
│   └── worker/       @repo/worker — Azure Service Bus consumer
├── packages/
│   ├── typescript-config/         shared tsconfig bases
│   ├── eslint-config/             flat ESLint v9 config + custom rules
│   ├── vitest-config/             shared vitest presets + .env.test loader
│   ├── env/          @repo/env    — the env boundary (parse/safeParse)
│   ├── logging/      @repo/logging— Winston + OpenTelemetry
│   ├── db/           @repo/db     — Kysely + Postgres
│   ├── trpc/         @repo/trpc   — the API contract & security boundary
│   ├── email/        @repo/email  — Resend / Mailpit + React Email
│   ├── sms/          @repo/sms    — Twilio (stub)
│   ├── cloud-storage/@repo/cloud-storage — Azure Blob / Azurite
│   └── service-bus/  @repo/service-bus    — Azure Service Bus helpers
├── docker/           dev + prod Dockerfiles
├── terraform/        Azure IaC (per-env, remote state, OIDC CI)
└── compose.yml       local dev stack
```

## Local development

1. Populate secrets: create `.env.secrets` (git-ignored) with `RESEND_API_KEY`,
   `BETTER_AUTH_SECRET`.
2. Boot the stack (Postgres, Service Bus emulator + mssql, Azurite, Mailpit, and
   the dev app container). This needs only Docker — the dev container runs its own
   `corepack enable` internally:

   ```sh
   docker compose up
   ```

3. Run migrations and seed. These are host-run commands, so enable corepack on the
   host first (also required for the git hooks, which run `pnpm` on commit):

   ```sh
   corepack enable   # once per machine; sets up the pinned pnpm on the host
   pnpm migrate
   pnpm seed
   ```

Host ports derive from `"portPrefix"` in `package.json` (default `170`) — see the
"Port prefix convention" section in `CLAUDE.md`. With the default prefix:

- Web: http://localhost:17000
- API: http://localhost:17001
- Mailpit UI: http://localhost:17021

### Common commands

| Command          | What it does                        |
| ---------------- | ----------------------------------- |
| `pnpm dev`       | Run every app in watch mode (turbo) |
| `pnpm build`     | Build all packages/apps             |
| `pnpm typecheck` | Typecheck the whole repo            |
| `pnpm lint`      | ESLint across the repo              |
| `pnpm test`      | Vitest across the repo              |
| `pnpm format`    | Prettier write                      |
| `pnpm migrate`   | Run DB migrations (`@repo/db`)      |
| `pnpm seed`      | Seed the DB                         |

### Adding a dependency while the dev container runs

The container keeps its own `node_modules` (anonymous volume). After adding on
the host, re-sync inside the container:

```sh
pnpm add <pkg> --filter <target-package>
docker compose exec dev pnpm install
```
