import { describe, expect, it } from 'vitest';
import {
  evaluateApprovalThreshold,
  approvalThresholdValueSchema,
  type ApprovalThresholdValue,
} from './threshold.js';

/**
 * Threshold evaluation (core plan 09 §9.2, PL-018 / AC-D5).
 *
 * The requirement is not any particular number — it is that the number lives in
 * configuration. So the suite's real subject is the boundary behaviour a
 * business user will reason about when they type one in, plus the fail-safe
 * direction when the rule and the request do not fit together.
 */

const gt500: ApprovalThresholdValue = { field: 'amount', op: 'gt', value: 500 };
const gte500: ApprovalThresholdValue = { field: 'amount', op: 'gte', value: 500 };

describe('approvalThresholdValueSchema', () => {
  it('accepts both rule shapes', () => {
    expect(approvalThresholdValueSchema.safeParse({ always: true }).success).toBe(true);
    expect(approvalThresholdValueSchema.safeParse(gt500).success).toBe(true);
  });

  it('rejects an unknown operator', () => {
    expect(
      approvalThresholdValueSchema.safeParse({ field: 'amount', op: 'lt', value: 500 }).success,
    ).toBe(false);
  });

  /** `{ always: false }` would mean "never require approval" — say so by not
   *  registering a policy, rather than by a rule that disables the engine. */
  it('rejects always:false', () => {
    expect(approvalThresholdValueSchema.safeParse({ always: false }).success).toBe(false);
  });
});

describe('evaluateApprovalThreshold — the default', () => {
  it('always requires approval', () => {
    expect(evaluateApprovalThreshold({ always: true }, { amount: 0 })).toEqual({
      required: true,
      reason: 'always',
    });
  });
});

describe('evaluateApprovalThreshold — gt vs gte at the boundary', () => {
  /** The pair of cases that make `gt` and `gte` worth offering separately. */
  it('gt does not fire exactly on the number', () => {
    expect(evaluateApprovalThreshold(gt500, { amount: 500 })).toEqual({
      required: false,
      reason: 'below_threshold',
    });
  });

  it('gte does fire exactly on the number', () => {
    expect(evaluateApprovalThreshold(gte500, { amount: 500 })).toEqual({
      required: true,
      reason: 'above_threshold',
    });
  });

  it('both fire above it', () => {
    expect(evaluateApprovalThreshold(gt500, { amount: 500.01 }).required).toBe(true);
    expect(evaluateApprovalThreshold(gte500, { amount: 501 }).required).toBe(true);
  });

  it('neither fires below it', () => {
    expect(evaluateApprovalThreshold(gt500, { amount: 499.99 }).required).toBe(false);
    expect(evaluateApprovalThreshold(gte500, { amount: 499.99 }).required).toBe(false);
  });

  it('handles negative amounts without special-casing them', () => {
    expect(evaluateApprovalThreshold(gt500, { amount: -1000 }).required).toBe(false);
  });
});

/**
 * The fail-safe direction. Every one of these could plausibly arrive from a
 * consumer whose `context` and whose threshold key drifted apart, and in every
 * one the answer must be "a human looks at it" — a redundant sign-off costs
 * someone a click, and the other error costs money nobody authorised.
 */
describe('evaluateApprovalThreshold — unevaluable rules require approval', () => {
  it('requires approval when the field is absent', () => {
    expect(evaluateApprovalThreshold(gt500, {})).toEqual({
      required: true,
      reason: 'unevaluable',
    });
  });

  it('requires approval when the field is not a number', () => {
    expect(evaluateApprovalThreshold(gt500, { amount: '600' }).reason).toBe('unevaluable');
    expect(evaluateApprovalThreshold(gt500, { amount: null }).reason).toBe('unevaluable');
    expect(evaluateApprovalThreshold(gt500, { amount: { gbp: 600 } }).reason).toBe('unevaluable');
  });

  /** NaN compares false against everything, so it would auto-approve silently. */
  it('requires approval for NaN and Infinity', () => {
    expect(evaluateApprovalThreshold(gt500, { amount: Number.NaN }).reason).toBe('unevaluable');
    expect(evaluateApprovalThreshold(gt500, { amount: Number.POSITIVE_INFINITY }).reason).toBe(
      'unevaluable',
    );
  });
});
