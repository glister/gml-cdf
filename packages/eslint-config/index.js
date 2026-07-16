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
