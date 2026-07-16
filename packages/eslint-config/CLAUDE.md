# @repo/eslint-config

Flat ESLint v9 config. Source-only, exports `.` → `index.js`.

- `baseConfig` — TS parser, `@typescript-eslint` recommended, `no-unused-vars`
  warn (`^_` ignore), `no-explicit-any` warn, prettier config last, ignores
  `dist`/`node_modules`/`.output`.
- `reactConfig` — extends base + react / react-hooks for tsx/jsx.

## Custom rule

`rules/no-process-env.js` → registered as `@repo/no-process-env: 'error'`.
Forbids direct `process.env` access; points devs at `parse()`/`safeParse()` from
`@repo/env`. The only sanctioned exceptions (the env loader itself) use inline
`// eslint-disable-next-line @repo/no-process-env` comments.
