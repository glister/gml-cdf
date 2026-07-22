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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

function readPrefix() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const prefix = pkg.portPrefix;
  if (!Number.isInteger(prefix) || prefix < 1) {
    throw new Error(`package.json "portPrefix" must be a positive integer, got: ${prefix}`);
  }
  return prefix;
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

function desiredValue(prefix, target, current) {
  if (target.kind === 'port') return String(portOf(prefix, target.slot));
  return substitutePorts(
    target.key,
    current,
    target.slots.map((s) => portOf(prefix, s)),
  );
}

// Returns { drift: [...], write?: newText }.
function processFile(prefix, file, targets, write) {
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
      desired = desiredValue(prefix, target, current);
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

function main() {
  const check = process.argv.includes('--check');
  const prefix = readPrefix();
  const problems = [];
  const writes = [];

  for (const [file, targets] of Object.entries(FILES)) {
    const { drift, text } = processFile(prefix, file, targets, !check);
    problems.push(...drift);
    if (text !== null) writes.push([join(ROOT, file), text]);
  }
  problems.push(...checkGlobalEnv());

  if (check) {
    if (problems.length) {
      for (const p of problems) console.error(`✖ ${p}`);
      console.error(`\n✖ ports out of sync with portPrefix ${prefix}. Run: pnpm ports:sync`);
      process.exit(1);
    }
    console.log(`✓ ports are in sync with portPrefix ${prefix}.`);
    return;
  }

  // sync: a missing key is fatal (can't be auto-created — we don't know placement).
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`);
    process.exit(1);
  }
  for (const [path, text] of writes) writeFileSync(path, text);
  console.log(
    `✓ synced .env / .env.test to portPrefix ${prefix} (host ports ${prefix}00–${prefix}29).`,
  );
}

main();
