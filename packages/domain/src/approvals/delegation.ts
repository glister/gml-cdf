import { isWithinPeriod } from '../lib/period.js';
import type { ActiveDelegation } from './policy.js';

/**
 * Delegation-window arithmetic (core plan 09 §4.5, HL-035 driver).
 *
 * A delegation says "Y carries X's approval authority between these two
 * instants, optionally only for this kind of sign-off". Deciding whether one is
 * in force is pure interval maths over instants the caller passes in — the same
 * discipline every effective-dated read in the platform follows (ADR-0009/0012).
 *
 * Windows are **half-open `[valid_from, valid_to)`**, matching `isWithinPeriod`
 * and plans 05/06: the delegate can act from the first instant of the window and
 * not at the instant it ends. Two consecutive delegations therefore never both
 * apply at the boundary, which is what stops a hand-over minute producing two
 * simultaneous stand-ins for one approver.
 */

/** A delegation row as the resolver reads it, before any window filtering. */
export interface DelegationWindow {
  id: string;
  delegatorPersonId: string;
  delegatePersonId: string;
  /** `null` = every subject type. */
  subjectType: string | null;
  validFrom: Date;
  validTo: Date;
  /** Early revocation; from this instant the delegation no longer applies. */
  revokedAt: Date | null;
}

export interface DelegationScope {
  /** The instant to evaluate at — a business time, never a clock read here. */
  at: Date;
  /**
   * The subject type of the request being resolved. An unscoped delegation
   * (`subjectType: null`) covers every type; a scoped one covers only its own.
   */
  subjectType: string;
}

/**
 * Is this delegation in force for this request, at this instant?
 *
 * Revocation is checked as its own half-open bound rather than by treating the
 * row as deleted: a delegation revoked at noon still authorised the decision
 * taken at eleven, and that has to stay true when the journal is re-read.
 */
export function isDelegationActive(delegation: DelegationWindow, scope: DelegationScope): boolean {
  if (delegation.subjectType !== null && delegation.subjectType !== scope.subjectType) {
    return false;
  }
  if (!isWithinPeriod(scope.at, delegation.validFrom, delegation.validTo)) return false;
  if (delegation.revokedAt !== null && scope.at.getTime() >= delegation.revokedAt.getTime()) {
    return false;
  }
  return true;
}

/**
 * Narrow a set of delegation rows to those in force, in the shape policy
 * expansion consumes.
 *
 * Splitting this from {@link expandApprovalPolicy} is deliberate: expansion then
 * has no notion of time at all, so "did the window include this instant?" and
 * "did this delegation reach an approver?" fail independently and are debugged
 * independently.
 */
export function activeDelegations(
  delegations: readonly DelegationWindow[],
  scope: DelegationScope,
): ActiveDelegation[] {
  return delegations
    .filter((delegation) => isDelegationActive(delegation, scope))
    .map((delegation) => ({
      id: delegation.id,
      delegatorPersonId: delegation.delegatorPersonId,
      delegatePersonId: delegation.delegatePersonId,
    }));
}

/** Rejected before any write: a delegation that could never be in force. */
export class DelegationWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationWindowError';
  }
}

export interface DelegationProposal {
  delegatorPersonId: string;
  delegatePersonId: string;
  validFrom: Date;
  validTo: Date;
}

/**
 * Check a proposed delegation before it is written (PL-016, §6's
 * `delegation.max_duration`).
 *
 * `maxDurationDays` is resolved from configuration by the caller and passed in —
 * an administrator can lengthen the ceiling without a release, and this function
 * still never reads a clock or a config store. The messages are written for the
 * person filling in the form, because they are what the form will show.
 */
export function assertDelegationValid(
  proposal: DelegationProposal,
  opts: { maxDurationDays: number },
): void {
  if (proposal.delegatePersonId === proposal.delegatorPersonId) {
    throw new DelegationWindowError('you cannot delegate your approvals to yourself');
  }
  if (proposal.validTo.getTime() <= proposal.validFrom.getTime()) {
    throw new DelegationWindowError('the delegation must end after it starts');
  }
  const days = (proposal.validTo.getTime() - proposal.validFrom.getTime()) / 86_400_000;
  if (days > opts.maxDurationDays) {
    throw new DelegationWindowError(
      `a delegation may not run for more than ${opts.maxDurationDays} days — set a shorter period, or renew it when it ends`,
    );
  }
}
