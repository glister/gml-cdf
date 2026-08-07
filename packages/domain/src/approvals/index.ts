/**
 * The approval engine's pure half (core plan 09 §9.2, ADR-0009): policy
 * expansion, delegation-window arithmetic and threshold evaluation.
 *
 * What is **not** here is the point. There are no inserts, no journal appends,
 * no compare-and-set on `approval_request.status` and no config reads — those
 * need a transaction and a database, and live in the engine services
 * (`@repo/trpc/lib/approvals.ts`). The split is what makes the parts that are
 * easy to get quietly wrong — "who may act once a role's membership changed?",
 * "is this delegation in force at the instant of the decision?", "does £500
 * clear a £500 threshold?" — testable with no database and no mocks.
 */
export {
  expandApprovalPolicy,
  findEligible,
  approvalApproverSchema,
  approvalApproverDesignatedSchema,
  approvalApproverRoleSchema,
  approvalPolicyValueSchema,
  approvalPolicyValueSchemaFor,
  type ActiveDelegation,
  type ApprovalApprover,
  type ApprovalApproverSource,
  type ApprovalPolicyInputs,
  type ApprovalPolicyValue,
  type ExpandedApprovalPolicy,
  type ResolvedApprover,
} from './policy.js';

export {
  activeDelegations,
  assertDelegationValid,
  isDelegationActive,
  DelegationWindowError,
  type DelegationProposal,
  type DelegationScope,
  type DelegationWindow,
} from './delegation.js';

export {
  evaluateApprovalThreshold,
  approvalThresholdAlwaysSchema,
  approvalThresholdComparisonSchema,
  approvalThresholdValueSchema,
  type ApprovalThresholdOutcome,
  type ApprovalThresholdReason,
  type ApprovalThresholdValue,
} from './threshold.js';
