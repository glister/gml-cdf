import { describe, expect, it } from 'vitest';
import { defineWorkflow } from './define.js';
import { demoRequestV1 } from './definitions/demo-request.js';
import { DEMO_EXPIRY_HOURS_KEY } from './demo-config-keys.js';
import {
  configRefsFor,
  evaluateTransition,
  scheduleConfigRefs,
  WorkflowGuardMissingError,
} from './evaluate.js';
import { guardRegistry } from './guards/registry.js';
import type { GuardContext, GuardRegistry } from './types.js';

/**
 * Pure transition evaluation and the demo guards (core plan 07 §10 — T-D3, T-D4,
 * T-D5, T-D7). Every instant is explicit; nothing here reads a clock, touches a
 * database or mocks anything, which is the property that makes the state-machine
 * layer worth having separately at all (ADR-0009).
 */

const T = (iso: string) => new Date(iso);

/** Wednesday 2026-08-05, 12:00 UTC — inside working hours. */
const IN_HOURS = T('2026-08-05T12:00:00.000Z');
/** The same Wednesday at 20:00 UTC — outside working hours. */
const OUT_OF_HOURS = T('2026-08-05T20:00:00.000Z');
/** Saturday 2026-08-08 at 12:00 UTC. */
const WEEKEND = T('2026-08-08T12:00:00.000Z');

const STARTED_AT = T('2026-08-05T09:00:00.000Z');

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    subject: { startedAt: STARTED_AT },
    input: {},
    config: { [DEMO_EXPIRY_HOURS_KEY]: 72 },
    now: IN_HOURS,
    ...overrides,
  };
}

describe('evaluateTransition — T-D3: a legal action returns its consequences', () => {
  it('returns the target state, effects, schedule and terminality', () => {
    const result = evaluateTransition(demoRequestV1, 'pending', 'approve', guardRegistry, ctx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.to).toBe('approved');
    expect(result.terminal).toBe(true);
    expect(result.effects).toEqual([
      { name: 'demo.recordOutcome', params: { outcome: 'approved' } },
    ]);
    expect(result.schedule).toEqual([]);
    expect(result.emits).toBeUndefined();
  });

  it('records a pass for every guard that neither warned nor blocked', () => {
    const result = evaluateTransition(demoRequestV1, 'pending', 'reject', guardRegistry, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.guardResults).toEqual([{ guard: 'demo.notExpired', outcome: 'pass' }]);
    expect(result.warnings).toEqual([]);
  });

  it('carries an emits override through when one is declared', () => {
    const withEmit = defineWorkflow({
      key: 'platform.test.emitter',
      version: 1,
      module: 'platform',
      states: ['open', 'closed'],
      initial: 'open',
      terminal: ['closed'],
      transitions: [
        {
          from: 'open',
          to: 'closed',
          action: 'close',
          by: { system: true },
          emits: 'platform.test_thing.closed',
        },
      ],
    });
    const result = evaluateTransition(withEmit, 'open', 'close', guardRegistry, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emits).toBe('platform.test_thing.closed');
  });
});

describe('evaluateTransition — T-D4: wrong state and unknown action are different failures', () => {
  it('an action the definition does not have is unknown-action', () => {
    const result = evaluateTransition(demoRequestV1, 'pending', 'escalate', guardRegistry, ctx());
    expect(result).toMatchObject({ ok: false, reason: 'unknown-action' });
  });

  it('a real action from the wrong state is wrong-state, and says where it is available', () => {
    const result = evaluateTransition(demoRequestV1, 'approved', 'approve', guardRegistry, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('wrong-state');
    expect(result.availableFrom).toEqual(['pending']);
  });

  it('distinguishing them matters: wrong-state is a race, unknown-action is a bad request', () => {
    // The stale-timer case (§5.4): a human approved first, so `expire` is no
    // longer available — and the runtime must treat that as a no-op, not an error.
    const stale = evaluateTransition(demoRequestV1, 'approved', 'expire', guardRegistry, ctx());
    expect(stale).toMatchObject({ ok: false, reason: 'wrong-state' });
  });
});

describe('evaluateTransition — T-D5: hard guards block, soft guards warn', () => {
  it('a hard guard blocks with its named reason and blocks the whole transition', () => {
    // 72h after 09:00 on the 5th is 09:00 on the 8th; evaluate a minute later.
    const result = evaluateTransition(
      demoRequestV1,
      'pending',
      'approve',
      guardRegistry,
      ctx({ now: T('2026-08-08T09:01:00.000Z') }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('guard-blocked');
    expect(result.blockedBy?.map((b) => b.guard)).toEqual(['demo.notExpired']);
    expect(result.detail).toMatch(/expired at 2026-08-08T09:00:00.000Z/);
  });

  it('the expiry boundary is inclusive: exactly at the instant, it is expired', () => {
    const atBoundary = evaluateTransition(
      demoRequestV1,
      'pending',
      'approve',
      guardRegistry,
      ctx({ now: T('2026-08-08T09:00:00.000Z') }),
    );
    expect(atBoundary).toMatchObject({ ok: false, reason: 'guard-blocked' });

    const aMinuteBefore = evaluateTransition(
      demoRequestV1,
      'pending',
      'approve',
      guardRegistry,
      // Still inside the window, but a Saturday — so it passes with a warning.
      ctx({ now: T('2026-08-08T08:59:00.000Z') }),
    );
    expect(aMinuteBefore.ok).toBe(true);
  });

  it('a soft guard lets the transition proceed and records the warning', () => {
    const result = evaluateTransition(
      demoRequestV1,
      'pending',
      'approve',
      guardRegistry,
      ctx({ now: OUT_OF_HOURS }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([
      { guard: 'demo.outOfHoursWarning', detail: expect.stringContaining('outside working hours') },
    ]);
    expect(result.guardResults).toContainEqual({
      guard: 'demo.outOfHoursWarning',
      outcome: 'warn',
      detail: expect.stringContaining('outside working hours'),
    });
  });

  it('warns at the weekend too, with a different reason', () => {
    const result = evaluateTransition(
      demoRequestV1,
      'pending',
      'approve',
      guardRegistry,
      ctx({ now: WEEKEND, subject: { startedAt: T('2026-08-08T09:00:00.000Z') } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings[0]?.detail).toMatch(/weekend/);
  });

  it('a hard guard blocking suppresses the transition even when a soft guard also fired', () => {
    const result = evaluateTransition(
      demoRequestV1,
      'pending',
      'approve',
      guardRegistry,
      // Expired AND out of hours: the block wins, and nothing is written.
      ctx({ now: T('2026-08-09T20:00:00.000Z') }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'guard-blocked' });
  });

  it('reports every blocking guard, not just the first', () => {
    const twoBlocks: GuardRegistry = {
      alwaysBlocksA: () => ({ outcome: 'block', detail: 'reason A' }),
      alwaysBlocksB: () => ({ outcome: 'block', detail: 'reason B' }),
    };
    const def = defineWorkflow({
      key: 'platform.test.blocked',
      version: 1,
      module: 'platform',
      states: ['open', 'closed'],
      initial: 'open',
      terminal: ['closed'],
      transitions: [
        {
          from: 'open',
          to: 'closed',
          action: 'close',
          by: { system: true },
          guards: ['alwaysBlocksA', 'alwaysBlocksB'],
        },
      ],
    });
    const result = evaluateTransition(def, 'open', 'close', twoBlocks, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockedBy).toHaveLength(2);
    expect(result.detail).toBe('alwaysBlocksA: reason A; alwaysBlocksB: reason B');
  });

  it('throws when a definition cites a guard nobody registered', () => {
    const def = defineWorkflow({
      key: 'platform.test.missing',
      version: 1,
      module: 'platform',
      states: ['open', 'closed'],
      initial: 'open',
      terminal: ['closed'],
      transitions: [
        {
          from: 'open',
          to: 'closed',
          action: 'close',
          by: { system: true },
          guards: ['nobody.registeredThis'],
        },
      ],
    });
    expect(() => evaluateTransition(def, 'open', 'close', guardRegistry, ctx())).toThrow(
      WorkflowGuardMissingError,
    );
  });
});

describe('guards — T-D7: everything a guard needs is injected', () => {
  it('the same guard gives opposite answers for two injected instants', () => {
    const early = evaluateTransition(
      demoRequestV1,
      'pending',
      'reject',
      guardRegistry,
      ctx({ now: T('2026-08-06T00:00:00.000Z') }),
    );
    const late = evaluateTransition(
      demoRequestV1,
      'pending',
      'reject',
      guardRegistry,
      ctx({ now: T('2026-08-30T00:00:00.000Z') }),
    );
    expect(early.ok).toBe(true);
    expect(late.ok).toBe(false);
  });

  it('the expiry window comes from injected config, not from a constant', () => {
    const now = T('2026-08-05T20:00:00.000Z'); // 11h after the request was raised
    const shortWindow = evaluateTransition(
      demoRequestV1,
      'pending',
      'reject',
      guardRegistry,
      ctx({ now, config: { [DEMO_EXPIRY_HOURS_KEY]: 2 } }),
    );
    const longWindow = evaluateTransition(
      demoRequestV1,
      'pending',
      'reject',
      guardRegistry,
      ctx({ now, config: { [DEMO_EXPIRY_HOURS_KEY]: 72 } }),
    );
    expect(shortWindow).toMatchObject({ ok: false, reason: 'guard-blocked' });
    expect(longWindow.ok).toBe(true);
  });

  it('an unresolvable decision point fails closed rather than falling back', () => {
    const result = evaluateTransition(
      demoRequestV1,
      'pending',
      'reject',
      guardRegistry,
      ctx({ config: {} }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/did not resolve to a number/);
  });

  it('a subject the loader could not supply fails closed', () => {
    const result = evaluateTransition(
      demoRequestV1,
      'pending',
      'reject',
      guardRegistry,
      ctx({ subject: null }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'guard-blocked' });
  });
});

describe('configRefsFor — what a transition snapshots', () => {
  it('collects the by policy, the declared guard config and any schedule refs', () => {
    const approve = demoRequestV1.transitions.find((t) => t.action === 'approve')!;
    expect(configRefsFor(approve).sort()).toEqual([
      'config:platform.workflow.demo.approver_role',
      'config:platform.workflow.demo.expiry_hours',
    ]);
  });

  it('a system transition with no decision points snapshots nothing', () => {
    const expire = demoRequestV1.transitions.find((t) => t.action === 'expire')!;
    expect(configRefsFor(expire)).toEqual([]);
  });

  it('reads the lead-time refs off a schedule', () => {
    expect(scheduleConfigRefs(demoRequestV1.initialSchedule ?? [])).toEqual([
      'config:platform.workflow.demo.expiry_hours',
    ]);
  });
});
