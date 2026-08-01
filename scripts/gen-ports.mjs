#!/usr/bin/env node
// Derive every externally-published local port from a single `portPrefix`
// (root package.json) plus a fixed slot convention shared across projects:
//
//   external port = portPrefix * 100 + slot
//
// Bands: apps 00–09, datastores/messaging 10–19, tooling/UI 20–29.
//
//   node scripts/gen-ports.mjs           # rewrite .env / .env.test in place
//   node scripts/gen-ports.mjs --check   # verify they are in sync (exit 1 on drift)
//
// Only the port is derived. For values that embed a port inside a larger string
// (URLs, connection strings) we substitute the port and leave everything else —
// credentials, hostnames, db names — untouched. Container-internal ports
// (API_INTERNAL_URL, PORT, the compose in-network overrides) are deliberately NOT
// managed here: the prefix governs host-published ports only.
//
// Worktree override: an untracked `.portPrefix` file at the repo root (a bare
// integer) takes precedence over package.json, so a git worktree can run the
// whole stack alongside the canonical checkout without port clashes. It also
// renames the docker compose project, otherwise both checkouts would drive the
// same set of containers/volumes regardless of ports. `.portPrefix` is
// git-ignored and `--check` refuses to let an override-derived `.env` /
// `.env.test` be committed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OVERRIDE_FILE = '.portPrefix';

// Base docker compose project name. The canonical checkout keeps it bare so its
// existing containers/volumes are not orphaned; an overriding worktree gets
// `<base>-<prefix>` so it owns an entirely separate stack.
const COMPOSE_PROJECT = 'cdf';

// slot = the last two digits of the derived port.
const SLOTS = {
  web: 0,
  api: 1,
  worker: 2,
  postgres: 10,
  // 11 reserved (was postgres-test). The test DB shares the dev Postgres
  // instance as a separate `cdf_test` database on the same host port, so no
  // dedicated test-datastore port is published.
  servicebus: 12,
  azurite: 13,
  mailpitSmtp: 20,
  mailpitUi: 21,
  // reserved: hyperdx UI 22, OTLP 23
};

// Which env-file keys each file manages. `port`: value is exactly the derived
// port. `url`: substitute the derived port(s) into the existing value, in order.
const FILES = {
  '.env': [
    // Compose reads COMPOSE_PROJECT_NAME from this file and it outranks the
    // top-level `name:` in compose.yml — that is what isolates a worktree's
    // containers, networks and volumes from the canonical checkout's.
    { key: 'COMPOSE_PROJECT_NAME', kind: 'project' },
    { key: 'PORT_WEB', kind: 'port', slot: 'web' },
    { key: 'PORT_API', kind: 'port', slot: 'api' },
    { key: 'PORT_WORKER', kind: 'port', slot: 'worker' },
    { key: 'POSTGRES_PORT', kind: 'port', slot: 'postgres' },
    { key: 'PORT_SERVICEBUS', kind: 'port', slot: 'servicebus' },
    { key: 'PORT_AZURITE', kind: 'port', slot: 'azurite' },
    { key: 'PORT_MAILPIT_SMTP', kind: 'port', slot: 'mailpitSmtp' },
    { key: 'PORT_MAILPIT_UI', kind: 'port', slot: 'mailpitUi' },
    { key: 'EMAIL_SMTP_PORT', kind: 'port', slot: 'mailpitSmtp' },
    { key: 'DATABASE_URL', kind: 'url', slots: ['postgres'] },
    { key: 'APP_URL', kind: 'url', slots: ['web'] },
    { key: 'BETTER_AUTH_URL', kind: 'url', slots: ['api'] },
    { key: 'BETTER_AUTH_TRUSTED_ORIGINS', kind: 'url', slots: ['web', 'api'] },
    { key: 'VITE_API_URL', kind: 'url', slots: ['api'] },
    { key: 'SERVICE_BUS_CONNECTION_STRING', kind: 'url', slots: ['servicebus'] },
    { key: 'AZURE_STORAGE_CONNECTION_STRING', kind: 'url', slots: ['azurite'] },
  ],
  '.env.test': [
    { key: 'PORT_WEB', kind: 'port', slot: 'web' },
    { key: 'PORT_API', kind: 'port', slot: 'api' },
    { key: 'PORT_WORKER', kind: 'port', slot: 'worker' },
    // Test DB shares the dev Postgres instance (same host port, `cdf_test` db).
    { key: 'POSTGRES_PORT', kind: 'port', slot: 'postgres' },
    { key: 'EMAIL_SMTP_PORT', kind: 'port', slot: 'mailpitSmtp' },
    { key: 'DATABASE_URL', kind: 'url', slots: ['postgres'] },
    { key: 'APP_URL', kind: 'url', slots: ['web'] },
    { key: 'BETTER_AUTH_URL', kind: 'url', slots: ['api'] },
    { key: 'BETTER_AUTH_TRUSTED_ORIGINS', kind: 'url', slots: ['web', 'api'] },
    { key: 'VITE_API_URL', kind: 'url', slots: ['api'] },
    { key: 'EXPO_PUBLIC_API_URL', kind: 'url', slots: ['api'] },
    { key: 'SERVICE_BUS_CONNECTION_STRING', kind: 'url', slots: ['servicebus'] },
    { key: 'AZURE_STORAGE_CONNECTION_STRING', kind: 'url', slots: ['azurite'] },
  ],
};

function parsePrefix(raw, source) {
  const prefix = typeof raw === 'string' ? (/^\d+$/.test(raw) ? Number(raw) : NaN) : raw;
  if (!Number.isInteger(prefix) || prefix < 1) {
    throw new Error(`${source} must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  return prefix;
}

// The canonical prefix (package.json) and the effective one (`.portPrefix` when
// present). They differ only in an overriding worktree.
function readPrefixes() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const canonical = parsePrefix(pkg.portPrefix, 'package.json "portPrefix"');

  const overridePath = join(ROOT, OVERRIDE_FILE);
  if (!existsSync(overridePath)) return { prefix: canonical, canonical, overridden: false };

  const prefix = parsePrefix(readFileSync(overridePath, 'utf8').trim(), OVERRIDE_FILE);
  return { prefix, canonical, overridden: prefix !== canonical };
}

const portOf = (prefix, slotName) => {
  if (!(slotName in SLOTS)) throw new Error(`unknown slot "${slotName}"`);
  return prefix * 100 + SLOTS[slotName];
};

// Replace each `:<digits>` occurrence with the next port in `ports`, in order.
function substitutePorts(key, value, ports) {
  let i = 0;
  const out = value.replace(/:(\d+)/g, () => {
    if (i >= ports.length) {
      throw new Error(`${key}: value has more ports than expected (${ports.length}): "${value}"`);
    }
    return `:${ports[i++]}`;
  });
  if (i !== ports.length) {
    throw new Error(`${key}: expected ${ports.length} port(s), found ${i}: "${value}"`);
  }
  return out;
}

function desiredValue({ prefix, canonical }, target, current) {
  if (target.kind === 'port') return String(portOf(prefix, target.slot));
  if (target.kind === 'project') {
    return prefix === canonical ? COMPOSE_PROJECT : `${COMPOSE_PROJECT}-${prefix}`;
  }
  return substitutePorts(
    target.key,
    current,
    target.slots.map((s) => portOf(prefix, s)),
  );
}

// Returns { drift: [...], write?: newText }.
function processFile(prefixes, file, targets, write) {
  const path = join(ROOT, file);
  const lines = readFileSync(path, 'utf8').split('\n');
  const drift = [];
  for (const target of targets) {
    const idx = lines.findIndex((l) => l.startsWith(`${target.key}=`));
    if (idx === -1) {
      drift.push(`${file}: missing managed key ${target.key}`);
      continue;
    }
    const current = lines[idx].slice(target.key.length + 1);
    let desired;
    try {
      desired = desiredValue(prefixes, target, current);
    } catch (err) {
      drift.push(`${file}: ${err.message}`);
      continue;
    }
    if (current === desired) continue;
    if (write) {
      lines[idx] = `${target.key}=${desired}`;
    } else {
      drift.push(`${file}: ${target.key}="${current}" — expected "${desired}"`);
    }
  }
  return { drift, text: write ? lines.join('\n') : null };
}

// Every managed `port` key must be declared in turbo.json globalEnv (CLAUDE.md).
function checkGlobalEnv() {
  const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));
  const declared = new Set(turbo.globalEnv ?? []);
  const managed = new Set();
  for (const targets of Object.values(FILES)) {
    for (const t of targets) if (t.kind === 'port') managed.add(t.key);
  }
  return [...managed]
    .filter((k) => !declared.has(k))
    .map((k) => `turbo.json globalEnv is missing managed port var ${k}`);
}

// An override rewrites tracked files, so committing them would push a worktree's
// private prefix onto everyone (and fail the ports-check CI gate, which sees no
// `.portPrefix`). Blocked here because `--check` runs in pre-commit.
function checkNotStaged() {
  let staged;
  try {
    staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', ...Object.keys(FILES)], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch {
    return []; // not a git repo / git unavailable — nothing to guard
  }
  return staged
    .split('\n')
    .filter(Boolean)
    .map(
      (f) =>
        `${f} is staged while ${OVERRIDE_FILE} overrides the prefix — unstage it (the ` +
        `override is local to this worktree and must not be committed)`,
    );
}

function main() {
  const check = process.argv.includes('--check');
  const prefixes = readPrefixes();
  const { prefix, canonical, overridden } = prefixes;
  const origin = overridden ? `${OVERRIDE_FILE} (canonical ${canonical})` : 'package.json';
  const problems = [];
  const writes = [];

  for (const [file, targets] of Object.entries(FILES)) {
    const { drift, text } = processFile(prefixes, file, targets, !check);
    problems.push(...drift);
    if (text !== null) writes.push([join(ROOT, file), text]);
  }
  problems.push(...checkGlobalEnv());
  if (overridden) problems.push(...checkNotStaged());

  if (check) {
    if (problems.length) {
      for (const p of problems) console.error(`✖ ${p}`);
      console.error(`\n✖ ports check failed for portPrefix ${prefix} (from ${origin}).`);
      console.error('  Drift is fixed by: pnpm ports:sync');
      process.exit(1);
    }
    console.log(`✓ ports are in sync with portPrefix ${prefix} (from ${origin}).`);
    return;
  }

  // sync: a missing key is fatal (can't be auto-created — we don't know placement).
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`);
    process.exit(1);
  }
  for (const [path, text] of writes) writeFileSync(path, text);
  console.log(
    `✓ synced .env / .env.test to portPrefix ${prefix} from ${origin} ` +
      `(host ports ${prefix}00–${prefix}29).`,
  );
  if (overridden) {
    console.log(
      `  ${OVERRIDE_FILE} is a local override: .env / .env.test are now dirty on purpose — ` +
        'do not commit them.',
    );
  }
}

try {
  main();
} catch (err) {
  // Config errors (a malformed prefix, an unknown slot) are user-fixable — a
  // stack trace only obscures them.
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
