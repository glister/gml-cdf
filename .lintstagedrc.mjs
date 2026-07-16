export default {
  '*.{ts,tsx,js,jsx}': ['eslint --fix', 'prettier --write'],
  '*.{json,md}': ['prettier --write'],
  '.github/workflows/*.yml': () => ['pnpm lint:pins', 'pnpm lint:actions'],
};
