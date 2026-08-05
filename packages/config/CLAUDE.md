# @repo/config

The configuration store's code-side half (core plan 06, ADR-0016).
**Source-only** — exports `./src/index.ts` directly (no build step).

`platform.config_entry.value` is `jsonb` with no SQL-level shape. What makes
that safe is this package, not a CHECK constraint: **every key is registered in
code with a Zod schema and a frozen default, and values are validated on write
AND on read.** There is no free-form-JSON escape hatch — an unregistered key
cannot be read, written, or referenced from a workflow definition.

## Layout

- `src/registry.ts` — `defineConfigKey`, the registry map, `requireConfigKey`.
  Validates the name grammar and the default against the key's own schema **at
  module load**, so a malformed registration fails on boot.
- `src/keys.ts` — the registered `platform.*` keys. **Registration is
  distributed by ownership**: each plan registers its own keys here when it
  builds. `hr.*` keys get their own module beside this one.
- `src/resolve.ts` — `getConfig` / `resolveConfig` (as-at reads),
  `setConfig` / `resetConfig` (the single write path, ADR-0022), and
  `parseConfigRef` for `config:` references in workflow definitions.
- `src/index.ts` — the barrel. **Always import through it**, never
  `./registry.js`: keys register as a side effect of loading `./keys.js`, and
  the barrel is what guarantees a populated registry.

`@repo/trpc` re-exports this package wholesale, so `import { getConfig } from
'@repo/trpc'` is equivalent and every pre-existing call site still works.

## Hard rules

- **Defaults are frozen once shipped.** Behaviour changes by writing a config
  entry, never by editing a `defaultValue` — an as-at read from before a key's
  first explicit entry would otherwise change meaning across releases, breaking
  the reproducibility the store exists for.
- **A value may never contain personal data.** Policies reference roles;
  membership resolves at use time (PL-021). A key whose value wants to point at
  an individual is a design error, not a configuration. This is what lets the
  audit event carry old and new values in full.
- **Reads are as-at.** `getConfig(db, def, { at })` accepts a `Transaction`, and
  callers making a durable decision resolve **inside the transaction that
  records it** with `at` = the decision's business time. That is what makes a
  past decision reproducible after the value has moved on.
- **`@repo/domain` never imports this.** Pure engines and workflow guards
  receive resolved config **values** as parameters; the orchestration layer does
  the resolving (ADR-0009/0013). The reverse dependency is a review-blocking
  smell and the domain package's lint config forbids it outright.

## Testing

`src/resolve.db.test.ts` runs against real Postgres (`cdf_test_config`) — as-at
window semantics and the close-only guard are SQL behaviour, and a mock database
would prove nothing about either (ADR-0004). `src/registry.test.ts` needs no
database.
