import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import noProcessEnv from './rules/no-process-env.js';

/** The `@repo` local plugin — currently just the no-process-env rule. */
const repoPlugin = {
  rules: {
    'no-process-env': noProcessEnv,
  },
};

/**
 * ADR-0008 rule 3: apps are never imported by other workspace members. Reused
 * across the `packages/**` block and (so it is not replaced by the more specific
 * `no-restricted-imports` there) the `packages/domain/**` purity block.
 */
const appsImportBan = {
  group: ['@repo/api', '@repo/web', '@repo/worker', '**/apps/*', '**/apps/*/**'],
  message: 'apps are never imported by workspace members — ADR-0008',
};

/**
 * ADR-0008 module boundaries + ADR-0009 `@repo/domain` purity, enforced as lint.
 * The router globs (`routers/hr`, `routers/platform`) do not exist until plans
 * 02/03 create them — glob-scoped flat-config blocks over absent paths are
 * inert, so the rules are landed now and bind the moment those directories
 * appear. Globs resolve against the repo-root `eslint.config.js`.
 */
const moduleBoundaries = [
  {
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [appsImportBan] }],
    },
  },
  {
    files: ['packages/trpc/src/routers/hr/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            appsImportBan,
            {
              group: ['**/routers/platform/**'],
              message:
                "cross-module access goes through the platform module's exported surface, not its internals — ADR-0008",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/trpc/src/routers/platform/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            appsImportBan,
            {
              group: ['**/routers/hr/**'],
              message:
                "cross-module access goes through the hr module's exported surface, not its internals — ADR-0008",
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-0014 adapter boundary: only `@repo/identity` reads/writes the Better
    // Auth framework tables (`user`/`account`/`session`). This is a best-effort
    // tripwire on the common Kysely accessors — like the platform/hr table
    // boundary, full enforcement is review (ESLint cannot see every SQL string).
    // Scoped to the app + router layers, so `@repo/identity` (the adapter) and
    // `@repo/db` (the data layer, seeds, test fixtures) are naturally exempt.
    files: ['apps/**/*.{ts,tsx}', 'packages/trpc/**/*.{ts,tsx}'],
    ignores: [
      // Tests seed framework tables directly to build scenarios.
      '**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.property.name=/^(selectFrom|insertInto|updateTable|deleteFrom)$/] > Literal[value=/^(user|account|session)( |$)/]',
          message:
            'Better Auth tables (user/account/session) are reached only through @repo/identity — ADR-0014',
        },
      ],
    },
  },
  {
    // `apps/web` resolves its own source through the `~/*` alias (declared in
    // `apps/web/tsconfig.json`, wired into Vite by `vite-tsconfig-paths`).
    //
    // Parent traversal is banned rather than merely discouraged because route
    // files are the ones that need it most and drift the fastest: TanStack Start
    // derives URLs from file position, so moving a route one directory changes
    // the correct depth of every `../` in the file. `~/components/ui/button` is
    // invariant under that move; `../../../../components/ui/button` is not.
    //
    // Sibling imports (`./Foo`) stay — they are unaffected by depth and read
    // better than an alias for a file in the same folder.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/routeTree.gen.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            appsImportBan,
            {
              group: ['../*'],
              message:
                "import app source through the '~/' alias (e.g. '~/components/ui/button'), not a parent-relative path — depth changes when a route moves",
            },
          ],
        },
      ],
    },
  },
  {
    // Same rule for `apps/mobile`, which resolves its own source through `@/*`
    // (declared in `apps/mobile/tsconfig.json`; Metro reads tsconfig paths via
    // `expo/metro-config`). The alias prefix differs from web's `~/` on purpose:
    // `@/` is the Expo template convention and the app already uses it
    // throughout, so unifying the two would be churn for no gain. Each app is
    // internally consistent, which is what matters at a call site.
    //
    // The same drift risk applies here: expo-router derives routes from file
    // position under `src/app/`, so a moved screen invalidates every `../` in
    // it. Asset requires already use `@/assets/*`, so they are unaffected.
    files: ['apps/mobile/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            appsImportBan,
            {
              group: ['../*'],
              message:
                "import app source through the '@/' alias (e.g. '@/components/themed-text'), not a parent-relative path — depth changes when a screen moves",
            },
          ],
        },
      ],
    },
  },
  {
    // @repo/domain is pure (ADR-0009): no I/O, DB, env, clock or randomness.
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@repo/db', message: '@repo/domain is pure — no database (ADR-0009)' },
            { name: '@repo/env', message: '@repo/domain is pure — no environment (ADR-0009)' },
            {
              name: '@repo/logging',
              message: '@repo/domain is pure — engines return values, callers log (ADR-0009)',
            },
            {
              name: '@repo/trpc',
              message: '@repo/domain is pure — no transport layer (ADR-0009)',
            },
            { name: 'kysely', message: '@repo/domain is pure — no database (ADR-0009)' },
            { name: 'pg', message: '@repo/domain is pure — no database (ADR-0009)' },
          ],
          patterns: [
            appsImportBan,
            {
              group: ['node:*'],
              message: '@repo/domain is pure — no Node builtins/I/O (ADR-0009)',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '@repo/domain is pure — no I/O (ADR-0009)' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: '@repo/domain is pure — pass the instant in, never read the clock (ADR-0009)',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: '@repo/domain is pure — pass the instant in, never read the clock (ADR-0009)',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: '@repo/domain is pure — randomness is a side effect (ADR-0009)',
        },
        {
          selector:
            "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
          message: '@repo/domain is pure — IDs are passed in, not generated (ADR-0009)',
        },
      ],
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const baseConfig = [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.output/**', '**/.turbo/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      '@repo': repoPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@repo/no-process-env': 'error',
      // Everything logs through @repo/logging. Standalone CLI scripts opt out
      // with an inline eslint-disable.
      'no-console': 'error',
    },
  },
  ...moduleBoundaries,
  prettierConfig,
];

/** @type {import('eslint').Linter.Config[]} */
export const reactConfig = [
  ...baseConfig,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    ...react.configs.flat.recommended,
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
  prettierConfig,
];

export default baseConfig;
