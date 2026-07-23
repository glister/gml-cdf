# @repo/identity

The identity adapter (ADR-0014, core plan 03). **Source-only** — exports
`./src/index.ts` directly (no build step; picked up live in dev).

## The boundary rule (review-blocking)

This package is the **only** code allowed to read or write the Better Auth
framework tables — `user`, `account`, `session`. Everything else (domain, tRPC
procedures, worker jobs, `apps/api` auth hooks) reaches identity through the
functions exported from `src/index.ts`. A `'user'`/`'account'`/`'session'`
table access anywhere outside `packages/identity` is a violation (ESLint
`no-restricted-imports`/boundary rule + review).

Why: it confines all Better Auth coupling to one place, so the framework stays
swappable and the durable `platform.person` remains the stable domain anchor.

## What the adapter does

- **Resolution** — credential → account → user → `person_id` (the sign-in path
  and the procedure-context lookup).
- **Linked identities** — list every credential across every user of a person
  (PL-035).
- **Person lifecycle** — ensure/attach a person for a new Entra user;
  pre-provision the Better Auth user for an invitation (the only external
  account-creation path, PL-036).
- **Merge/unmerge** — repoint/restore `user.person_id` only; `account`/`session`
  rows are never touched, so both logins keep working post-merge (AC-8).
- **Sign-in enable/disable** — wraps the framework ban (PL-042); domain code
  never sets `user.banned`.
- **Lineage** — union-of-history reads across a person and its superseded
  persons (recursive CTE).

## Conventions

- Never `process.env` (use `@repo/env`); never `console.log` (use
  `@repo/logging`).
- Config constants live in `src/config.ts` (Zod-validated); they migrate to
  `platform.config_entry` when plan 06 lands (§6 of the plan).
