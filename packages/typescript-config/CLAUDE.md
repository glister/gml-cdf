# @repo/typescript-config

Shared TS config bases. Source-only, no build. Consumed via `extends`.

- `base.json` — strict, bundler resolution, ESNext modules, ES2022 target,
  declaration + sourcemaps. Every other config extends this.
- `node.json` — adds `types: [node]`, `outDir ./dist`, `rootDir ./src`. For
  Node apps/packages.
- `react.json` — adds `jsx: react-jsx`, DOM libs. For web.

No deps. Add new bases here rather than duplicating compilerOptions in packages.
