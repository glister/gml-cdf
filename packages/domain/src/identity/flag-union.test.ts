import { describe, expect, it } from 'vitest';
import { type ActiveFlag, planFlagUnion } from './flag-union.js';

const flag = (id: string, flagType: ActiveFlag['flagType'], reason = 'r'): ActiveFlag => ({
  id,
  flagType,
  reason,
});

describe('planFlagUnion', () => {
  it('copies a loser flag whose type the survivor lacks', () => {
    const plan = planFlagUnion([], [flag('l1', 'do_not_rehire', 'past incident')]);
    expect(plan).toEqual([
      { sourceFlagId: 'l1', flagType: 'do_not_rehire', reason: 'past incident' },
    ]);
  });

  it('does not copy a type the survivor already has active', () => {
    const plan = planFlagUnion([flag('s1', 'do_not_rehire')], [flag('l1', 'do_not_rehire')]);
    expect(plan).toEqual([]);
  });

  it('copies every distinct loser flag of a missing type (never-lose over-copies)', () => {
    const plan = planFlagUnion([], [flag('l1', 'safety', 'height'), flag('l2', 'safety', 'ppe')]);
    expect(plan.map((p) => p.sourceFlagId)).toEqual(['l1', 'l2']);
  });

  it('copies only the missing types when survivor has some', () => {
    const plan = planFlagUnion(
      [flag('s1', 'safeguarding')],
      [flag('l1', 'safeguarding'), flag('l2', 'do_not_rehire')],
    );
    expect(plan.map((p) => p.flagType)).toEqual(['do_not_rehire']);
  });

  it('returns nothing when the loser has no active flags', () => {
    expect(planFlagUnion([flag('s1', 'safety')], [])).toEqual([]);
  });
});
