import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigKeyUnknownError,
  configRegistry,
  defineConfigKey,
  qualifiedName,
  requireConfigKey,
  unregisterConfigKeyForTests,
} from './registry.js';
import { externalAccessDefaultDays } from './keys.js';

/**
 * Registry unit tests (core plan 06 test 10-T1). No database: the registry is
 * the code-side half of the contract, and every rule here is meant to fail at
 * module load rather than at first use (ADR-0016 fail-fast).
 */

const scratch: string[] = [];

/** Register a throwaway key and remember it, so the shared registry stays clean. */
function defineScratchKey(overrides: Partial<Parameters<typeof defineConfigKey>[0]> = {}) {
  const def = {
    namespace: 'platform.test',
    key: 'scratch_value',
    schema: z.number().int(),
    defaultValue: 1,
    description: 'scratch',
    editableBy: ['administrator'] as const,
    registeredBy: 'test',
    ...overrides,
  } as Parameters<typeof defineConfigKey>[0];
  const registered = defineConfigKey(def);
  scratch.push(qualifiedName(registered));
  return registered;
}

afterEach(() => {
  for (const name of scratch.splice(0)) unregisterConfigKeyForTests(name);
});

describe('defineConfigKey', () => {
  it('registers a key under its qualified name', () => {
    const def = defineScratchKey();
    expect(qualifiedName(def)).toBe('platform.test.scratch_value');
    expect(configRegistry.get('platform.test.scratch_value')).toBe(def);
  });

  it('throws on duplicate registration', () => {
    defineScratchKey();
    expect(() => defineScratchKey()).toThrow(/duplicate config key registration/);
  });

  it('rejects a default that fails the key’s own schema', () => {
    expect(() => defineScratchKey({ schema: z.number().int().min(10), defaultValue: 1 })).toThrow(
      /default that fails its own schema/,
    );
  });

  it('rejects malformed namespaces and keys', () => {
    expect(() => defineScratchKey({ namespace: 'Platform.Identity' })).toThrow(
      /invalid config namespace/,
    );
    expect(() => defineScratchKey({ namespace: 'platform..identity' })).toThrow(
      /invalid config namespace/,
    );
    expect(() => defineScratchKey({ key: 'defaultDays' })).toThrow(/invalid config key/);
    // A dot in the key would move a segment into the namespace silently.
    expect(() => defineScratchKey({ key: 'a.b' })).toThrow(/invalid config key/);
  });

  it('rejects a key nobody may edit — that is a constant, not configuration', () => {
    expect(() => defineScratchKey({ editableBy: [] })).toThrow(/no editableBy roles/);
  });

  it('freezes the definition so a consumer cannot mutate the contract', () => {
    const def = defineScratchKey();
    expect(Object.isFrozen(def)).toBe(true);
  });
});

describe('requireConfigKey', () => {
  it('returns a registered definition', () => {
    expect(requireConfigKey('platform.identity.external_access_default_days')).toBe(
      externalAccessDefaultDays,
    );
  });

  it('throws ConfigKeyUnknownError for an unregistered key', () => {
    expect(() => requireConfigKey('platform.identity.nope')).toThrow(ConfigKeyUnknownError);
    // The store has no free-form escape hatch: a namespace that exists does not
    // make an unregistered key inside it readable (ADR-0016).
    expect(() => requireConfigKey('platform.identity')).toThrow(ConfigKeyUnknownError);
  });
});

describe('the pilot key', () => {
  it('is registered with the agreed shape (§6, §12.2 Q2)', () => {
    expect(externalAccessDefaultDays.defaultValue).toBe(90);
    expect(externalAccessDefaultDays.editableBy).toEqual(['administrator']);
    expect(externalAccessDefaultDays.registeredBy).toBe('06');
  });

  it('bounds the window at both ends — 0 and “forever” both defeat PL-042', () => {
    expect(externalAccessDefaultDays.schema.safeParse(0).success).toBe(false);
    expect(externalAccessDefaultDays.schema.safeParse(366).success).toBe(false);
    expect(externalAccessDefaultDays.schema.safeParse(45.5).success).toBe(false);
    expect(externalAccessDefaultDays.schema.safeParse(45).success).toBe(true);
  });
});

describe('the registry as a whole', () => {
  it('registers every key under a name matching its namespace and key', () => {
    for (const [name, def] of configRegistry) {
      expect(name).toBe(qualifiedName(def));
    }
  });

  const personish = /person_?id|_by$|email/i;

  /**
   * Strip `{placeholder}` tokens before matching.
   *
   * A substitution token is not a person reference: `people/{person_id}/` names
   * nobody — it is a *shape* the filing worker expands per document (core plan
   * 11 §6). Without this the tripwire fires on every later plan that configures a
   * path or a template, and a check that cries wolf gets deleted rather than
   * fixed. Everything outside the braces is still matched, so a literal id, a
   * `"…_by"` key or an address in a default trips exactly as before — asserted
   * below, because a tripwire nobody re-arms after loosening it is worse than
   * none.
   */
  const withoutPlaceholders = (value: string) => value.replace(/\{[a-z0-9_]+\}/gi, '');

  it('holds no key whose default value embeds a person reference (§4.5)', () => {
    // A blunt check, but it is the rule that most needs a tripwire: policies
    // reference roles, never named individuals (PL-021). A key wanting to point
    // at a person is a design error, and this is where it surfaces.
    for (const [name, def] of configRegistry) {
      const serialised = withoutPlaceholders(JSON.stringify(def.defaultValue ?? null));
      expect(serialised, `${name} default looks like it names a person`).not.toMatch(personish);
    }
  });

  it('the person-reference tripwire is still armed for real references', () => {
    // The shapes the rule catches, none of which can hide inside braces — which
    // is the whole basis for stripping placeholders above.
    expect(withoutPlaceholders(JSON.stringify({ person_id: 'abc' }))).toMatch(personish);
    expect(withoutPlaceholders(JSON.stringify({ personId: 'abc' }))).toMatch(personish);
    expect(withoutPlaceholders(JSON.stringify({ notify: 'email' }))).toMatch(personish);
    // And a placeholder alone is not a reference.
    expect(withoutPlaceholders(JSON.stringify('people/{person_id}/'))).not.toMatch(personish);

    // NOTE (core plan 11, 2026-08-07): the pattern's third alternative, `_by$`,
    // is **dead**. It is matched against `JSON.stringify(...)` output, which
    // always ends in `"`, `}`, `]` or a digit — never in `_by` — so no value can
    // reach it. Left alone rather than fixed here: the guard belongs to core plan
    // 06, and tightening it could newly fail keys this plan does not own.
    // Reported for that plan to close.
    expect(JSON.stringify({ approved_by: 'abc' })).not.toMatch(/_by$/);
  });
});
