import { afterEach, describe, expect, it } from 'vitest';
// Through the barrel, never `./approval-subjects.js`: the pilot subject
// registers as a side effect of loading `./keys.js`, and the barrel is what
// guarantees it has. Importing the module alone is exactly how the last three
// assertions in this file would silently test an empty registry.
import {
  approvalSubjectTypes,
  defineApprovalSubject,
  isApprovalSubject,
  qualifiedName,
  requireApprovalSubject,
  unregisterApprovalSubjectForTests,
  unregisterConfigKeyForTests,
  ApprovalSubjectUnknownError,
} from './index.js';

/**
 * Per-subject-type approval configuration (core plan 09 §6).
 *
 * The rules under test are all **load-time** ones: a malformed subject
 * registration must fail on boot rather than at the first submit against it,
 * because by then the failure is someone's request disappearing rather than a
 * red build (ADR-0016 fail-fast).
 */

const registered: string[] = [];

function register(subjectType: string, over: Record<string, unknown> = {}) {
  const def = defineApprovalSubject({
    subjectType,
    policyDefault: { mode: 'any-one', approvers: [{ kind: 'role', roleKey: 'administrator' }] },
    policyDescription: 'test',
    thresholdDescription: 'test',
    registeredBy: 'test',
    ...over,
  } as Parameters<typeof defineApprovalSubject>[0]);
  registered.push(subjectType);
  return def;
}

afterEach(() => {
  for (const subjectType of registered.splice(0)) {
    const def = requireApprovalSubject(subjectType);
    unregisterConfigKeyForTests(qualifiedName(def.policy));
    unregisterConfigKeyForTests(qualifiedName(def.threshold));
    unregisterConfigKeyForTests(qualifiedName(def.reminderCadence));
    unregisterApprovalSubjectForTests(subjectType);
  }
});

describe('defineApprovalSubject — key derivation', () => {
  /**
   * The split is at the **last** dot of the stream name, so the module becomes
   * a namespace segment and the entity the key. Getting this wrong would put
   * two subject types' policies on one key.
   */
  it('derives three keys from the subject type', () => {
    const def = register('hr.leave_booking');

    expect(qualifiedName(def.policy)).toBe('platform.approvals.policy.hr.leave_booking');
    expect(qualifiedName(def.threshold)).toBe('platform.approvals.threshold.hr.leave_booking');
    expect(qualifiedName(def.reminderCadence)).toBe(
      'platform.approvals.reminder.cadence.hr.leave_booking',
    );
  });

  it('keeps two subject types on separate keys', () => {
    const leave = register('hr.leave_booking');
    const toil = register('hr.toil_claim');
    expect(qualifiedName(leave.policy)).not.toBe(qualifiedName(toil.policy));
  });
});

describe('defineApprovalSubject — defaults', () => {
  /**
   * A subject type whose threshold nobody has set must ask a human. The other
   * direction would mean enabling approvals on something silently approved
   * everything until someone noticed.
   */
  it('defaults the threshold to always-require-approval', () => {
    expect(register('hr.leave_booking').threshold.defaultValue).toEqual({ always: true });
  });

  /**
   * `null`, not a copy of the engine-wide cadence: a copied default would pin
   * this subject type to whatever the global value happened to be on the day it
   * was registered, and a later global change would silently skip it.
   */
  it('defaults the cadence override to null, not to the global value', () => {
    expect(register('hr.leave_booking').reminderCadence.defaultValue).toBeNull();
  });
});

describe('defineApprovalSubject — load-time rejections', () => {
  it('rejects a subject type that is not a <module>.<entity> stream name', () => {
    expect(() => register('leave_booking')).toThrow(/journal stream name/);
    expect(() => register('hr.leave.booking')).toThrow(/journal stream name/);
    expect(() => register('HR.leaveBooking')).toThrow(/journal stream name/);
  });

  it('rejects a duplicate registration', () => {
    register('hr.leave_booking');
    expect(() => register('hr.leave_booking')).toThrow(/already registered/);
  });

  /**
   * A default policy pointing at a resolver the subject type does not declare
   * would resolve to nobody — a request that opens and notifies no one, which
   * looks like a delivery failure rather than a configuration mistake.
   */
  it('rejects a default policy naming an undeclared designated source', () => {
    expect(() =>
      register('hr.leave_booking', {
        policyDefault: {
          mode: 'any-one',
          approvers: [{ kind: 'designated', source: 'leave_approvers' }],
        },
      }),
    ).toThrow(/does not declare .* designatedSources/);
  });

  it('accepts a designated default when the source is declared', () => {
    const def = register('hr.leave_booking', {
      policyDefault: {
        mode: 'any-one',
        approvers: [{ kind: 'designated', source: 'leave_approvers' }],
      },
      designatedSources: ['leave_approvers'],
    });
    expect(def.designatedSources).toEqual(['leave_approvers']);
  });

  /** `defineConfigKey` validates the default against its own schema at load. */
  it('rejects a default policy that fails the policy schema', () => {
    expect(() =>
      register('hr.leave_booking', { policyDefault: { mode: 'any-one', approvers: [] } }),
    ).toThrow(/fails its own schema/);
  });
});

describe('requireApprovalSubject', () => {
  it('returns a registered subject type', () => {
    register('hr.leave_booking');
    expect(requireApprovalSubject('hr.leave_booking').subjectType).toBe('hr.leave_booking');
    expect(isApprovalSubject('hr.leave_booking')).toBe(true);
  });

  /**
   * Approvals are opt-in per subject type, so the refusal names the thing to do
   * rather than reporting a missing key — the caller is a developer wiring up a
   * new consumer, not an administrator.
   */
  it('throws a directive error for an unregistered subject type', () => {
    expect(() => requireApprovalSubject('hr.nothing')).toThrow(ApprovalSubjectUnknownError);
    expect(() => requireApprovalSubject('hr.nothing')).toThrow(/defineApprovalSubject/);
    expect(isApprovalSubject('hr.nothing')).toBe(false);
  });
});

describe('the pilot subject (§9.8)', () => {
  /** Registered by `./keys.js`, which the barrel loads — the slice's entry point. */
  it('is registered with an administrator policy and an HR override', () => {
    const pilot = requireApprovalSubject('platform.pilot_signoff');
    expect(pilot.policy.defaultValue).toEqual({
      mode: 'any-one',
      approvers: [{ kind: 'role', roleKey: 'administrator' }],
      overrideRoles: ['hr_user'],
    });
  });

  /** AC-D5's raw material: a number an administrator can edit without a release. */
  it('carries an editable spend threshold', () => {
    expect(requireApprovalSubject('platform.pilot_signoff').threshold.defaultValue).toEqual({
      field: 'amount',
      op: 'gt',
      value: 500,
    });
  });

  it('appears in the registered subject list', () => {
    expect(approvalSubjectTypes()).toContain('platform.pilot_signoff');
  });
});
