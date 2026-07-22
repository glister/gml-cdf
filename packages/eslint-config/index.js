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
