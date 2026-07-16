# @repo/vitest-config

Shared Vitest presets. Source-only, exports `./vitest.config`.

- `baseConfig` — node env.
- `browserConfig` — jsdom env.
- default → `baseConfig`.

Both enable `globals`, v8 coverage (excludes node_modules/dist/config/`types.ts`),
and register `setup-env.ts`.

`setup-env.ts` walks up (max 10 levels) to the repo-root `.env.test`, parses it
line by line, and sets each key into `process.env` **only if undefined** so
per-package/CI overrides win. Runs before every suite. Consuming packages do
`mergeConfig(baseConfig, defineConfig({...}))`.
