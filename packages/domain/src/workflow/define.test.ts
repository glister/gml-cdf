import { describe, expect, it } from 'vitest';
import { defineWorkflow, WorkflowDefinitionError } from './define.js';
import { allDefinitions } from './definitions/index.js';
import { guardRegistry } from './guards/registry.js';
import type { WorkflowDefinition } from './types.js';

/**
 * `defineWorkflow` validation and the serialisability contract (core plan 07 §10
 * — T-D1, T-D2, T-D6). No database, no clock, no mocks.
 *
 * T-D6 is the load-bearing one: it is the Phase 2 door (WF-1). Everything else
 * here catches an authoring mistake; that one catches a design mistake that
 * would not surface until Phase 2 tried to store definitions as data.
 */

/** A minimal valid definition; each test perturbs exactly one thing. */
function base(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    key: 'platform.test.shape',
    version: 1,
    states: ['open', 'closed'],
    initial: 'open',
    terminal: ['closed'],
    transitions: [{ from: 'open', to: 'closed', action: 'close', by: { role: 'administrator' } }],
    ...overrides,
  };
}

describe('defineWorkflow — T-D1: a valid definition is accepted', () => {
  it('accepts the minimal shape and returns it frozen', () => {
    const def = defineWorkflow(base());
    expect(def.key).toBe('platform.test.shape');
    expect(Object.isFrozen(def)).toBe(true);
  });

  it('accepts every actor-policy form', () => {
    for (const by of [
      { role: 'hr_user' },
      { configRef: 'config:platform.workflow.demo.approver_role' as const },
      { system: true as const },
    ]) {
      expect(() =>
        defineWorkflow(
          base({ transitions: [{ from: 'open', to: 'closed', action: 'close', by }] }),
        ),
      ).not.toThrow();
    }
  });

  it('accepts fixed and config-resolved timer lead times', () => {
    expect(() =>
      defineWorkflow(
        base({
          initialSchedule: [
            { actionType: 'workflow.transition', delay: { unit: 'days', amount: 7 } },
            {
              actionType: 'notification.reminder',
              delay: { unit: 'hours', configRef: 'config:platform.test.lead_hours' },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe('defineWorkflow — T-D2: malformed definitions are rejected', () => {
  const cases: Array<[string, Partial<WorkflowDefinition>, RegExp]> = [
    ['a non-namespaced key', { key: 'shape' }, /lowercase, namespaced, dotted/],
    ['a zero version', { version: 0 }, /positive integer/],
    ['a fractional version', { version: 1.5 }, /positive integer/],
    ['duplicate states', { states: ['open', 'open', 'closed'] }, /states must be unique/],
    [
      'an initial state outside states',
      { initial: 'nowhere' },
      /initial state 'nowhere' is not in states/,
    ],
    [
      'a terminal state outside states',
      { terminal: ['gone'] },
      /terminal state 'gone' is not in states/,
    ],
    [
      'a transition entering an unknown state',
      {
        transitions: [{ from: 'open', to: 'void', action: 'close', by: { role: 'administrator' } }],
      },
      /enters unknown state 'void'/,
    ],
    [
      'a transition leaving an unknown state',
      {
        states: ['open', 'closed', 'limbo'],
        transitions: [
          { from: 'open', to: 'closed', action: 'close', by: { role: 'administrator' } },
          { from: 'ghost', to: 'closed', action: 'skip', by: { role: 'administrator' } },
        ],
      },
      /leaves unknown state 'ghost'/,
    ],
    [
      'a duplicate (from, action) pair',
      {
        states: ['open', 'closed', 'void'],
        terminal: ['closed', 'void'],
        transitions: [
          { from: 'open', to: 'closed', action: 'close', by: { role: 'administrator' } },
          { from: 'open', to: 'void', action: 'close', by: { role: 'administrator' } },
        ],
      },
      /duplicate transition for \(from='open', action='close'\)/,
    ],
    [
      'a transition out of a terminal state',
      {
        transitions: [
          { from: 'open', to: 'closed', action: 'close', by: { role: 'administrator' } },
          { from: 'closed', to: 'open', action: 'reopen', by: { role: 'administrator' } },
        ],
      },
      /leaves terminal state 'closed'/,
    ],
    [
      'an unreachable state',
      {
        states: ['open', 'closed', 'orphan'],
        terminal: ['closed', 'orphan'],
      },
      /state 'orphan' is unreachable/,
    ],
    [
      'a non-terminal dead end',
      {
        states: ['open', 'stuck', 'closed'],
        terminal: ['closed'],
        transitions: [
          { from: 'open', to: 'stuck', action: 'wait', by: { role: 'administrator' } },
          { from: 'open', to: 'closed', action: 'close', by: { role: 'administrator' } },
        ],
      },
      /state 'stuck' is not terminal but has no outgoing transition/,
    ],
    [
      'an empty action name',
      { transitions: [{ from: 'open', to: 'closed', action: '', by: { role: 'administrator' } }] },
      /empty action name/,
    ],
    [
      'a malformed config reference',
      {
        transitions: [
          {
            from: 'open',
            to: 'closed',
            action: 'close',
            by: { configRef: 'platform.x.y' as never },
          },
        ],
      },
      /not a valid configuration reference/,
    ],
    [
      'an emits name that is not an event type',
      {
        transitions: [
          {
            from: 'open',
            to: 'closed',
            action: 'close',
            by: { role: 'administrator' },
            emits: 'Closed',
          },
        ],
      },
      /not a valid event type/,
    ],
  ];

  it.each(cases)('rejects %s', (_label, overrides, message) => {
    expect(() => defineWorkflow(base(overrides))).toThrow(WorkflowDefinitionError);
    expect(() => defineWorkflow(base(overrides))).toThrow(message);
  });

  it('rejects an initial state that is also terminal', () => {
    expect(() => defineWorkflow(base({ terminal: ['open', 'closed'] }))).toThrow(
      /is also terminal/,
    );
  });

  it('rejects a `by` policy naming an individual rather than a role (§8)', () => {
    expect(() =>
      defineWorkflow(
        base({
          transitions: [
            {
              from: 'open',
              to: 'closed',
              action: 'close',
              by: { role: '0198f5c2-6c3e-7a1b-9f4d-2b8a1c5e7d90' },
            },
          ],
        }),
      ),
    ).toThrow(/names an individual .* rather than a role/);
  });

  it('rejects a negative delay amount', () => {
    expect(() =>
      defineWorkflow(
        base({
          initialSchedule: [
            { actionType: 'workflow.transition', delay: { unit: 'days', amount: -1 } },
          ],
        }),
      ),
    ).toThrow(/non-negative finite number/);
  });
});

describe('defineWorkflow — T-D6: serialisability is the Phase 2 door (WF-1)', () => {
  it('rejects a definition carrying a function', () => {
    expect(() =>
      defineWorkflow(
        base({
          transitions: [
            {
              from: 'open',
              to: 'closed',
              action: 'close',
              by: { role: 'administrator' },
              // A guard smuggled in as a closure rather than a registry name —
              // works perfectly today, un-storable in Phase 2.
              effects: [{ name: 'x', params: { fn: () => true } }],
            },
          ],
        }),
      ),
    ).toThrow(/not serialisable/);
  });

  it('rejects a definition carrying a Date', () => {
    expect(() =>
      defineWorkflow(
        base({
          transitions: [
            {
              from: 'open',
              to: 'closed',
              action: 'close',
              by: { role: 'administrator' },
              effects: [{ name: 'x', params: { after: new Date('2026-01-01T00:00:00.000Z') } }],
            },
          ],
        }),
      ),
    ).toThrow(/not serialisable/);
  });

  it('rejects a definition carrying a Map', () => {
    expect(() =>
      defineWorkflow(
        base({
          transitions: [
            {
              from: 'open',
              to: 'closed',
              action: 'close',
              by: { role: 'administrator' },
              effects: [{ name: 'x', params: { lookup: new Map([['a', 1]]) } }],
            },
          ],
        }),
      ),
    ).toThrow(/not serialisable/);
  });

  it('tolerates an explicitly-undefined optional key (absent ≡ undefined)', () => {
    expect(() =>
      defineWorkflow(
        base({
          transitions: [
            {
              from: 'open',
              to: 'closed',
              action: 'close',
              by: { role: 'administrator' },
              guards: undefined,
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('every registered definition survives a JSON round trip unchanged', () => {
    const registered = allDefinitions();
    expect(registered.length).toBeGreaterThan(0);
    for (const def of registered) {
      expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    }
  });
});

describe('registered definitions conform to the registries they cite', () => {
  it('every guard named by a definition is registered', () => {
    for (const def of allDefinitions()) {
      for (const t of def.transitions) {
        for (const guard of t.guards ?? []) {
          expect(guardRegistry, `${def.key} v${def.version} cites guard '${guard}'`).toHaveProperty(
            guard,
          );
        }
      }
    }
  });

  it('every (key, version) pair is registered exactly once', () => {
    const ids = allDefinitions().map((d) => `${d.key}@${d.version}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
