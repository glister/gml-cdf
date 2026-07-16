// Learn more: https://docs.expo.dev/guides/monorepos/
// CommonJS: Metro/Babel tooling is CJS, so this app does not set "type":"module".
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Also watch the monorepo root so changes in workspace packages (e.g.
//    @repo/trpc, @repo/env) are picked up by Metro. Append to Expo's defaults.
config.watchFolders = [...(config.watchFolders ?? []), monorepoRoot];

// 2. Resolve modules from the app first, then the workspace root (pnpm keeps
//    hoistable deps at the root).
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 3. Resolve `.ts`/`.tsx` source of workspace packages that publish source via
//    package `exports` (source-only @repo/* packages).
config.resolver.unstable_enablePackageExports = true;

module.exports = withNativeWind(config, { input: './src/global.css' });
