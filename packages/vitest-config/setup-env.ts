import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Vitest global setup: load the repo-root `.env.test` into `process.env` for keys
 * that are not already set, so per-package/CI overrides win. Runs before every
 * suite. We walk up from CWD (max 10 levels) to find `.env.test` at the repo root.
 */
function findEnvTest(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, '.env.test');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envTestPath = findEnvTest();
if (envTestPath) {
  const contents = readFileSync(envTestPath, 'utf8');
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // eslint-disable-next-line @repo/no-process-env -- the env loader itself must touch process.env
    if (process.env[key] === undefined) {
      // eslint-disable-next-line @repo/no-process-env -- the env loader itself must touch process.env
      process.env[key] = value;
    }
  }
}
