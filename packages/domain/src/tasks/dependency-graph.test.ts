import { describe, expect, it } from 'vitest';
import {
  assertAcyclic,
  evaluateUnlocks,
  initialStatus,
  sameBlocker,
  CycleError,
  type DependencyEdge,
} from './dependency-graph.js';

/** Core plan 08 §10, PL-014. */

const gate = (gateKey: string) => ({ kind: 'gate' as const, gateKey });
const task = (taskId: string) => ({ kind: 'task' as const, taskId });

describe('assertAcyclic', () => {
  it('accepts an empty graph', () => {
    expect(() => assertAcyclic([])).not.toThrow();
  });

  it('accepts a chain', () => {
    expect(() =>
      assertAcyclic([
        { taskRef: 'b', dependsOnRef: 'a' },
        { taskRef: 'c', dependsOnRef: 'b' },
      ]),
    ).not.toThrow();
  });

  it('accepts a diamond', () => {
    expect(() =>
      assertAcyclic([
        { taskRef: 'b', dependsOnRef: 'a' },
        { taskRef: 'c', dependsOnRef: 'a' },
        { taskRef: 'd', dependsOnRef: 'b' },
        { taskRef: 'd', dependsOnRef: 'c' },
      ]),
    ).not.toThrow();
  });

  it('accepts several disconnected components', () => {
    expect(() =>
      assertAcyclic([
        { taskRef: 'b', dependsOnRef: 'a' },
        { taskRef: 'y', dependsOnRef: 'x' },
      ]),
    ).not.toThrow();
  });

  it('rejects a self-dependency', () => {
    expect(() => assertAcyclic([{ taskRef: 'a', dependsOnRef: 'a' }])).toThrow(CycleError);
  });

  it('rejects a direct cycle', () => {
    expect(() =>
      assertAcyclic([
        { taskRef: 'a', dependsOnRef: 'b' },
        { taskRef: 'b', dependsOnRef: 'a' },
      ]),
    ).toThrow(CycleError);
  });

  it('rejects a transitive cycle and names the loop', () => {
    try {
      assertAcyclic([
        { taskRef: 'a', dependsOnRef: 'c' },
        { taskRef: 'b', dependsOnRef: 'a' },
        { taskRef: 'c', dependsOnRef: 'b' },
      ]);
      expect.unreachable();
    } catch (error) {
      const cycle = (error as CycleError).cycle;
      // Three distinct members plus the repeated node that closes the loop.
      expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
      expect(cycle.at(0)).toBe(cycle.at(-1));
    }
  });

  it('rejects a cycle that only exists once both halves are combined', () => {
    // The realistic case: the graph already in the database plus the list being
    // raised. Neither set alone contains a loop.
    const existing = [{ taskRef: 'existing', dependsOnRef: 'new' }];
    const raising = [{ taskRef: 'new', dependsOnRef: 'existing' }];
    expect(() => assertAcyclic(existing)).not.toThrow();
    expect(() => assertAcyclic(raising)).not.toThrow();
    expect(() => assertAcyclic([...existing, ...raising])).toThrow(CycleError);
  });

  it('reports the cycle even when acyclic tasks hang off it', () => {
    expect(() =>
      assertAcyclic([
        { taskRef: 'a', dependsOnRef: 'b' },
        { taskRef: 'b', dependsOnRef: 'a' },
        { taskRef: 'downstream', dependsOnRef: 'a' },
        { taskRef: 'unrelated', dependsOnRef: 'clean' },
      ]),
    ).toThrow(CycleError);
  });
});

describe('initialStatus', () => {
  it('is open with nothing outstanding and blocked otherwise', () => {
    expect(initialStatus(0)).toBe('open');
    expect(initialStatus(1)).toBe('blocked');
    expect(initialStatus(4)).toBe('blocked');
  });
});

describe('sameBlocker', () => {
  it('compares within a kind and never across kinds', () => {
    expect(sameBlocker(task('t1'), task('t1'))).toBe(true);
    expect(sameBlocker(task('t1'), task('t2'))).toBe(false);
    expect(sameBlocker(gate('verification'), gate('verification'))).toBe(true);
    expect(sameBlocker(gate('verification'), gate('other'))).toBe(false);
    expect(sameBlocker(gate('verification'), task('verification'))).toBe(false);
  });
});

describe('evaluateUnlocks', () => {
  const edges: DependencyEdge[] = [
    // `two` waits only on `one`.
    { taskId: 'two', blocker: task('one'), satisfied: false },
    // `three` waits on `one` AND the verification gate.
    { taskId: 'three', blocker: task('one'), satisfied: false },
    { taskId: 'three', blocker: gate('verification'), satisfied: false },
    // `four` waits only on the gate.
    { taskId: 'four', blocker: gate('verification'), satisfied: false },
  ];

  it('unlocks exactly the tasks whose last blocker cleared', () => {
    expect(evaluateUnlocks(edges, task('one'))).toEqual(['two']);
  });

  it('unlocks a task once its other blocker was already satisfied', () => {
    const partly = edges.map((e) =>
      e.taskId === 'three' && e.blocker.kind === 'gate' ? { ...e, satisfied: true } : e,
    );
    expect(evaluateUnlocks(partly, task('one')).sort()).toEqual(['three', 'two']);
  });

  it('opening a gate unlocks all and only the tasks it was blocking', () => {
    const oneDone = edges.map((e) => (e.blocker.kind === 'task' ? { ...e, satisfied: true } : e));
    expect(evaluateUnlocks(oneDone, gate('verification')).sort()).toEqual(['four', 'three']);
  });

  it('returns nothing for a blocker no task waits on (a bypassed gate)', () => {
    expect(evaluateUnlocks(edges, gate('nobody_waits_on_this'))).toEqual([]);
  });

  it('does not re-announce a task that was never blocked by this edge', () => {
    // `two` is unblocked by `one`; satisfying the gate must not mention it.
    expect(evaluateUnlocks(edges, gate('verification'))).toEqual(['four']);
  });

  it('is empty when the satisfied edge leaves another outstanding', () => {
    expect(evaluateUnlocks(edges, gate('verification'))).not.toContain('three');
  });
});
