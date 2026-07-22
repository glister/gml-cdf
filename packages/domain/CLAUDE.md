# @repo/domain

The pure business-logic home (ADR-0009, core plan 01). **Source-only** — exports
`./src/index.ts` directly (no build step; picked up live in dev). Every
calculation engine the platform grows lives here, not inside tRPC procedures.

## Purity rules (hard — lint-enforced, not aspirational)

1. **No I/O**: no `node:fs`, `node:net`, `node:http(s)`, `node:child_process`, no
   `fetch`.
2. **No database**: importing `@repo/db`, `kysely` or `pg` is banned.
3. **No environment**: importing `@repo/env` (or touching `process.env` — already
   repo-wide banned) is banned.
4. **No clock or randomness**: `new Date()` with zero args, `Date.now()`,
   `Math.random()`, `crypto.randomUUID()` are banned inside the package — **time
   and IDs are always passed in as parameters.**
5. **No logging**: engines return values/results; callers log.
6. **Everything is a deterministic function of its arguments** — 100%
   unit-testable with no mocks and no test database.

Rules 1–5 are enforced by a `packages/domain/**` block in
`packages/eslint-config/index.js` (`no-restricted-imports` +
`no-restricted-syntax`); each violation points at ADR-0009. Rule 6 is the review
rule: **a tRPC procedure that grows business logic is a smell — the logic moves
here.**

## Layout

- `src/index.ts` — the only entry point; engines are re-exported here.
- `src/lib/*` — individual engines. `period.ts` (effective-dated interval math)
  is the pilot: half-open `[from, to)` helpers with time passed in, used by the
  effective-dated reads in plans 05/06.

## Testing

`pnpm turbo test --filter=@repo/domain` must pass **with no database running and
no mocks** — that property is the whole point of the package (ADR-0009). If a
test needs a DB or a fixed clock injected, the code under test belongs in a
different layer.
