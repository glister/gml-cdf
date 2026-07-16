# @repo/env

The env boundary. Source-only, exports `.` → `src/index.ts`. Only dep: `zod`.

## API

- `parse(schema, source = process.env)` — validates; on failure throws with a
  readable multi-line report (`- NAME: missing (required)` /
  `expected X got Y`); on success returns typed data. Use for fail-fast startup.
- `safeParse(schema, source = process.env)` — non-throwing; returns Zod's
  discriminated union.

Both accept a custom `source` so client (Vite) code can pass `import.meta.env`.

## Rule

Every package/app defines its OWN local Zod schema and reads config through
these functions. This file is the ONLY sanctioned `process.env` read in the repo
(guarded by an inline eslint-disable). Never add defaults for required vars —
fail fast. Every new var also needs a test-safe default in the root `.env.test`.
