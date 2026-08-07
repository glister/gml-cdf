import { describe, expect, it } from 'vitest';
import type { RoleKey } from '../authz/roles.js';
import {
  expandApprovalPolicy,
  findEligible,
  approvalPolicyValueSchema,
  type ActiveDelegation,
  type ApprovalPolicyInputs,
  type ApprovalPolicyValue,
} from './policy.js';

/**
 * Policy expansion (core plan 09 §9.2, PL-016/PL-021).
 *
 * The property under test throughout is the one §4.5 exists to defend: the
 * *policy* decides who may act, and it decides it from memberships resolved at
 * the moment of asking. Nothing here freezes a person into a request.
 */

const ALICE = '0192f3a4-0000-7000-8000-00000000a11c';
const BOB = '0192f3a4-0000-7000-8000-00000000b0b0';
const CARA = '0192f3a4-0000-7000-8000-00000000ca2a';
const DAN = '0192f3a4-0000-7000-8000-00000000da70';
const DELEGATION = '0192f3a4-0000-7000-8000-0000000de1e6';

function inputs(over: Partial<ApprovalPolicyInputs> = {}): ApprovalPolicyInputs {
  return {
    roleMembers: new Map<RoleKey, readonly string[]>(),
    designatedMembers: new Map<string, readonly string[]>(),
    delegations: [],
    ...over,
  };
}

const roleOnly: ApprovalPolicyValue = {
  mode: 'any-one',
  approvers: [{ kind: 'role', roleKey: 'line_manager' }],
};

describe('approvalPolicyValueSchema', () => {
  it('accepts role and designated approvers with override roles', () => {
    const parsed = approvalPolicyValueSchema.safeParse({
      mode: 'any-one',
      approvers: [
        { kind: 'role', roleKey: 'line_manager' },
        { kind: 'designated', source: 'leave_approvers' },
      ],
      overrideRoles: ['hr_user'],
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * The rule this schema exists to enforce (plan 06 §4.5, PL-021): a policy may
   * not name an individual. Strictness is what makes it structural rather than a
   * review convention — there is no key to put a person id under.
   */
  it('rejects an approver that names a person', () => {
    const parsed = approvalPolicyValueSchema.safeParse({
      mode: 'any-one',
      approvers: [{ kind: 'person', personId: ALICE }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a policy with no approvers at all', () => {
    const parsed = approvalPolicyValueSchema.safeParse({ mode: 'any-one', approvers: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown role key', () => {
    const parsed = approvalPolicyValueSchema.safeParse({
      mode: 'any-one',
      approvers: [{ kind: 'role', roleKey: 'chief_wizard' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('expandApprovalPolicy — role approvers', () => {
  it('resolves every current holder of the role, and notifies them all', () => {
    const result = expandApprovalPolicy(
      roleOnly,
      inputs({ roleMembers: new Map([['line_manager', [ALICE, BOB]]]) }),
    );

    expect(result.notify.map((a) => a.personId).sort()).toEqual([ALICE, BOB].sort());
    expect(result.eligible.map((a) => a.personId).sort()).toEqual([ALICE, BOB].sort());
    expect(result.notify.every((a) => a.source === 'policy_role')).toBe(true);
    expect(result.notify[0]!.roleKey).toBe('line_manager');
  });

  /**
   * The membership-change case, at the level this function can see it: the same
   * policy with different memberships resolves to different people, with no
   * change to the policy. Live re-resolution against the database is proved in
   * the router's real-Postgres suite; this is the pure half of PL-021.
   */
  it('follows the membership, not the policy', () => {
    const before = expandApprovalPolicy(
      roleOnly,
      inputs({ roleMembers: new Map([['line_manager', [ALICE]]]) }),
    );
    const after = expandApprovalPolicy(
      roleOnly,
      inputs({ roleMembers: new Map([['line_manager', [BOB]]]) }),
    );

    expect(before.eligible.map((a) => a.personId)).toEqual([ALICE]);
    expect(after.eligible.map((a) => a.personId)).toEqual([BOB]);
  });

  it('resolves to nobody when the role is empty', () => {
    const result = expandApprovalPolicy(roleOnly, inputs());
    expect(result.notify).toEqual([]);
    expect(result.eligible).toEqual([]);
  });
});

describe('expandApprovalPolicy — designated approvers', () => {
  it('resolves the people the named resolver returned', () => {
    const result = expandApprovalPolicy(
      { mode: 'any-one', approvers: [{ kind: 'designated', source: 'leave_approvers' }] },
      inputs({ designatedMembers: new Map([['leave_approvers', [CARA]]]) }),
    );

    expect(result.eligible).toEqual([
      { personId: CARA, source: 'designated', designatedSource: 'leave_approvers' },
    ]);
  });

  /**
   * A resolver that produced nothing must not throw mid-submit. The service
   * rejects *unregistered* resolvers when the subject type is registered, so an
   * empty result here means "this employee has no designated approver yet" —
   * a real state, and one the caller journals rather than crashes on.
   */
  it('contributes nobody when the resolver returned nothing', () => {
    const result = expandApprovalPolicy(
      { mode: 'any-one', approvers: [{ kind: 'designated', source: 'leave_approvers' }] },
      inputs(),
    );
    expect(result.eligible).toEqual([]);
  });
});

describe('expandApprovalPolicy — override roles (HL-033)', () => {
  const withOverride: ApprovalPolicyValue = {
    mode: 'any-one',
    approvers: [{ kind: 'role', roleKey: 'line_manager' }],
    overrideRoles: ['hr_user'],
  };

  /**
   * The requirement, verbatim: "HR can view and act on any request **without
   * being notified of all of them**". Collapsing notify and eligible into one
   * set would break one half or the other.
   */
  it('makes override holders eligible but never notified', () => {
    const result = expandApprovalPolicy(
      withOverride,
      inputs({
        roleMembers: new Map([
          ['line_manager', [ALICE]],
          ['hr_user', [CARA]],
        ]),
      }),
    );

    expect(result.notify.map((a) => a.personId)).toEqual([ALICE]);
    expect(result.eligible.map((a) => a.personId).sort()).toEqual([ALICE, CARA].sort());
  });

  it('notifies someone who is both a named approver and an override holder', () => {
    const result = expandApprovalPolicy(
      withOverride,
      inputs({
        roleMembers: new Map([
          ['line_manager', [ALICE]],
          ['hr_user', [ALICE]],
        ]),
      }),
    );

    expect(result.notify.map((a) => a.personId)).toEqual([ALICE]);
    expect(result.eligible).toHaveLength(1);
  });
});

describe('expandApprovalPolicy — delegation', () => {
  const delegation: ActiveDelegation = {
    id: DELEGATION,
    delegatorPersonId: ALICE,
    delegatePersonId: BOB,
  };

  it('makes the delegate eligible and notified, carrying the delegation id', () => {
    const result = expandApprovalPolicy(
      roleOnly,
      inputs({ roleMembers: new Map([['line_manager', [ALICE]]]), delegations: [delegation] }),
    );

    expect(result.notify.map((a) => a.personId).sort()).toEqual([ALICE, BOB].sort());
    const bob = findEligible(result, BOB);
    expect(bob).toEqual({
      personId: BOB,
      source: 'delegation',
      delegationId: DELEGATION,
      onBehalfOfPersonId: ALICE,
    });
  });

  /** A delegation from someone with no authority confers none. */
  it('ignores a delegation whose delegator is not an approver', () => {
    const result = expandApprovalPolicy(
      roleOnly,
      inputs({
        roleMembers: new Map([['line_manager', [CARA]]]),
        delegations: [delegation],
      }),
    );

    expect(result.eligible.map((a) => a.personId)).toEqual([CARA]);
  });

  /**
   * One hop only. X→Y→Z does not make Z an approver: Y covering X is a decision
   * X made, and Z covering X is not.
   */
  it('does not chain delegations', () => {
    const result = expandApprovalPolicy(
      roleOnly,
      inputs({
        roleMembers: new Map([['line_manager', [ALICE]]]),
        delegations: [delegation, { id: 'd2', delegatorPersonId: BOB, delegatePersonId: CARA }],
      }),
    );

    expect(result.eligible.map((a) => a.personId).sort()).toEqual([ALICE, BOB].sort());
    expect(findEligible(result, CARA)).toBeUndefined();
  });

  /** A delegate of an override holder inherits the silence along with the power. */
  it('leaves a delegate of an override holder eligible but unnotified', () => {
    const result = expandApprovalPolicy(
      {
        mode: 'any-one',
        approvers: [{ kind: 'role', roleKey: 'line_manager' }],
        overrideRoles: ['hr_user'],
      },
      inputs({
        roleMembers: new Map([
          ['line_manager', [ALICE]],
          ['hr_user', [CARA]],
        ]),
        delegations: [{ id: 'd3', delegatorPersonId: CARA, delegatePersonId: DAN }],
      }),
    );

    expect(result.notify.map((a) => a.personId)).toEqual([ALICE]);
    expect(result.eligible.map((a) => a.personId).sort()).toEqual([ALICE, CARA, DAN].sort());
  });

  /**
   * Provenance precedence: a person who is both a role holder and someone's
   * delegate is recorded by the stronger claim, so the assignee row describes
   * them the way a human would.
   */
  it('prefers a direct role claim over a delegated one', () => {
    const result = expandApprovalPolicy(
      roleOnly,
      inputs({
        roleMembers: new Map([['line_manager', [ALICE, BOB]]]),
        delegations: [delegation],
      }),
    );

    expect(findEligible(result, BOB)!.source).toBe('policy_role');
    expect(result.eligible).toHaveLength(2);
  });
});
