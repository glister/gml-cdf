import { baseConfig } from '@repo/eslint-config';

export default [
  ...baseConfig,
  // Generated / CJS tooling config in the mobile app is not linted.
  {
    ignores: [
      'apps/mobile/.expo/**',
      'apps/mobile/expo-env.d.ts',
      'apps/mobile/nativewind-env.d.ts',
      'apps/mobile/babel.config.js',
      'apps/mobile/metro.config.js',
      'apps/mobile/tailwind.config.js',
      'apps/mobile/scripts/**',
    ],
  },
  // React Native (apps/mobile) idioms: Metro loads static assets via
  // `require('./x.png')`, resolved at bundle time. This is idiomatic RN, not a
  // code smell — the `no-process-env` guardrail stays on (see EXPO_PUBLIC_* usage
  // routed through @repo/env).
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
