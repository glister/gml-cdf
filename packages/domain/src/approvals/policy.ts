import { z } from 'zod';
import { ROLE_KEYS, type RoleKey } from '../authz/roles.js';

/**
 * Approver-policy shape and expansion (core plan 09 §4.5/§6, PL-016/PL-021).
 *
 * A policy says *how* to find approvers, never *who* they are. Expanding one is
 * a pure function of the policy value plus already-resolved memberships — the
 * orchestration layer does the config read, the role-grant query and the
 * delegation query, and hands the answers in (ADR-0009). That split is what
 * makes the awkward part — "who may act, who gets told, and are those the same
 * set?" — testable with no database.
 *
 * ## Two sets, not one
 *
 * Expansion yields `notify` and `eligible`, and they deliberately differ:
 *
 *  - **`notify`** is who gets asked — the policy's own `approvers`, plus anyone
 *    currently carrying their authority by delegation.
 *  - **`eligible`** is who may act — all of the above **plus** `overrideRoles`,
 *    who may decide any request but are never notified of every one. That is
 *    HL-033 verbatim ("HR can view and act on any request without being
 *    notified of all of them"), and collapsing the two sets would either spam HR
 *    with every leave request or deny them the authority the SoW grants.
 *
 * ## What a policy may not contain
 *
 * There is **no `person` approver kind**. A config value may not name an
 * individual (plan 06 §4.5, PL-021): a policy naming Alice keeps naming Alice
 * after she changes role, which is precisely the redirection this engine's live
 * re-resolution exists to guarantee. A named individual reaches a request either
 * through a **role** (they are identified by function, and membership resolves
 * live) or through a **`designated` resolver** reading a table with a real
 * person FK — end-dateable, and visible to plan 16's erasure sweep.
 */

/** An approver named by role. Membership resolves at use time (PL-021). */
export const approvalApproverRoleSchema = z.strictObject({
  kind: z.literal('role'),
  roleKey: z.enum(ROLE_KEYS),
});

/**
 * An approver set the consuming module resolves per subject — "this employee's
 * designated leave approvers" (HL-032). `source` names a resolver registered in
 * code, exactly as a workflow guard or warning provider is named; the engine
 * defines the interface and the consuming plan implements it.
 */
export const approvalApproverDesignatedSchema = z.strictObject({
  kind: z.literal('designated'),
  source: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, 'a lowercase snake_case resolver name, e.g. leave_approvers'),
});

export const approvalApproverSchema = z.discriminatedUnion('kind', [
  approvalApproverRoleSchema,
  approvalApproverDesignatedSchema,
]);

/**
 * The value stored at `platform.approvals.policy.<subjectType>`.
 *
 * `mode` is a discriminator with one member today. Phase 1 needs only
 * any-one-approves (PL-016); leaving the field in place means a future
 * `all-of`/`quorum` mode is a schema widening rather than a migration, which is
 * the extension seam §12.3 counts on.
 */
export const approvalPolicyValueSchema = z.strictObject({
  mode: z.literal('any-one'),
  approvers: z.array(approvalApproverSchema).min(1).max(20),
  /** May act on any request of this subject type; never notified (HL-033). */
  overrideRoles: z.array(z.enum(ROLE_KEYS)).max(10).optional(),
});

export type ApprovalApprover = z.infer<typeof approvalApproverSchema>;
export type ApprovalPolicyValue = z.infer<typeof approvalPolicyValueSchema>;

/**
 * The policy schema **narrowed to one subject type's declared resolvers**.
 *
 * {@link approvalPolicyValueSchema} above accepts any well-formed resolver name,
 * which is right for describing the shape but wrong for validating a stored
 * value: a `designated` source is only meaningful if something is registered to
 * answer it, and the permissive schema would happily accept a typo.
 *
 * That gap mattered because approver policies are **runtime-editable
 * configuration** (PL-016). An administrator writing
 * `{ kind: 'designated', source: 'leave_aprovers' }` would have passed
 * validation, then failed at the next `submit` — and, worse, quietly emptied the
 * inbox for that subject type, because eligibility resolution fails closed.
 * Configuration that can silently stop work reaching people is exactly what
 * ADR-0016's validate-on-write-and-on-read discipline exists to prevent.
 *
 * So `defineApprovalSubject` builds each subject type's key against this
 * instead. The set comes from the subject's `designatedSources` declaration, so
 * the config store, the admin editor and the resolver registry all validate
 * against one list — and a bad source is refused at the moment it is typed,
 * naming the sources that would have worked.
 *
 * A subject type declaring **no** sources gets a union with no `designated`
 * member at all: for those, "there are no designated approvers here" is a
 * property of the schema rather than a rule someone has to remember.
 */
export function approvalPolicyValueSchemaFor(
  designatedSources: readonly string[],
): z.ZodType<ApprovalPolicyValue> {
  const approver =
    designatedSources.length === 0
      ? z.discriminatedUnion('kind', [approvalApproverRoleSchema])
      : z.discriminatedUnion('kind', [
          approvalApproverRoleSchema,
          z.strictObject({
            kind: z.literal('designated'),
            source: z.enum([...designatedSources] as [string, ...string[]]),
          }),
        ]);

  return z.strictObject({
    mode: z.literal('any-one'),
    approvers: z.array(approver).min(1).max(20),
    overrideRoles: z.array(z.enum(ROLE_KEYS)).max(10).optional(),
  }) as unknown as z.ZodType<ApprovalPolicyValue>;
}

/** How a person came to be on a request — mirrors `approval_assignee.source`. */
export type ApprovalApproverSource = 'policy_role' | 'designated' | 'delegation';

/** One resolved approver, carrying the provenance the assignee row records. */
export interface ResolvedApprover {
  personId: string;
  source: ApprovalApproverSource;
  /** Set when `source === 'policy_role'` — the service maps key → role id. */
  roleKey?: RoleKey;
  /** Set when `source === 'designated'` — which resolver produced them. */
  designatedSource?: string;
  /** Set when `source === 'delegation'`. */
  delegationId?: string;
  /** Set when `source === 'delegation'` — whose authority they are carrying. */
  onBehalfOfPersonId?: string;
}

/**
 * A delegation already narrowed to "active now, for this subject type" by
 * {@link activeDelegations}. Expansion does no window arithmetic of its own.
 */
export interface ActiveDelegation {
  id: string;
  delegatorPersonId: string;
  delegatePersonId: string;
}

/**
 * Everything expansion needs, resolved by the caller (ADR-0009).
 *
 * `roleMembers` and `designatedMembers` are keyed by the identifiers the policy
 * uses — role **keys**, not row ids, and resolver names — so a policy value and
 * this input can be compared by eye in a test failure.
 */
export interface ApprovalPolicyInputs {
  /** Role key → person ids currently holding an active grant for it. */
  roleMembers: ReadonlyMap<RoleKey, readonly string[]>;
  /** Resolver name → person ids it returned for this subject. */
  designatedMembers: ReadonlyMap<string, readonly string[]>;
  /** Delegations in force now, already scoped to this request's subject type. */
  delegations: readonly ActiveDelegation[];
}

export interface ExpandedApprovalPolicy {
  /** Who to ask. Ordered: policy approvers first, then their delegates. */
  notify: ResolvedApprover[];
  /** Who may act — `notify` plus override-role holders and their delegates. */
  eligible: ResolvedApprover[];
}

/**
 * Precedence when one person arrives by several routes. A direct role
 * membership is the most informative provenance and a delegation the least, so
 * the strongest claim wins and the assignee row records how they would most
 * naturally be described.
 */
const SOURCE_RANK: Record<ApprovalApproverSource, number> = {
  policy_role: 0,
  designated: 1,
  delegation: 2,
};

/** Insert `approver` unless this person already has an equal-or-stronger claim. */
function upsert(into: Map<string, ResolvedApprover>, approver: ResolvedApprover): void {
  const existing = into.get(approver.personId);
  if (existing && SOURCE_RANK[existing.source] <= SOURCE_RANK[approver.source]) return;
  into.set(approver.personId, approver);
}

/** The direct (undelegated) approvers a list of policy entries resolves to. */
function expandDirect(
  approvers: readonly ApprovalApprover[],
  inputs: ApprovalPolicyInputs,
): Map<string, ResolvedApprover> {
  const out = new Map<string, ResolvedApprover>();
  for (const approver of approvers) {
    if (approver.kind === 'role') {
      for (const personId of inputs.roleMembers.get(approver.roleKey) ?? []) {
        upsert(out, { personId, source: 'policy_role', roleKey: approver.roleKey });
      }
    } else {
      // An unregistered resolver contributes nobody rather than throwing: the
      // service rejects unknown resolvers at registration time, and a policy
      // that resolves to an empty set is a real (loudly journalled) state, not
      // a crash in the middle of someone's submit.
      for (const personId of inputs.designatedMembers.get(approver.source) ?? []) {
        upsert(out, { personId, source: 'designated', designatedSource: approver.source });
      }
    }
  }
  return out;
}

/**
 * Everyone currently carrying the authority of someone in `holders`.
 *
 * Delegation is **one hop, deliberately**. If X delegates to Y and Y delegates
 * to Z, Z does not inherit X's authority: a chain nobody wrote down explicitly
 * is a chain nobody has agreed to, and two hops is enough to lose track of whose
 * sign-off a decision actually represents. Y covering X is a decision X made; Z
 * covering X is not.
 */
function expandDelegations(
  holders: ReadonlyMap<string, ResolvedApprover>,
  delegations: readonly ActiveDelegation[],
): ResolvedApprover[] {
  const out: ResolvedApprover[] = [];
  for (const delegation of delegations) {
    if (!holders.has(delegation.delegatorPersonId)) continue;
    // A delegate who is already an approver in their own right keeps that
    // claim; `upsert`'s ranking handles it at the merge below.
    out.push({
      personId: delegation.delegatePersonId,
      source: 'delegation',
      delegationId: delegation.id,
      onBehalfOfPersonId: delegation.delegatorPersonId,
    });
  }
  return out;
}

/**
 * Expand a policy into the notify and eligible sets (§4.5).
 *
 * Pure: the same policy and the same inputs always give the same answer, which
 * is what lets "who could have approved this on 3 March?" be reconstructed from
 * the journal rather than guessed at.
 */
export function expandApprovalPolicy(
  policy: ApprovalPolicyValue,
  inputs: ApprovalPolicyInputs,
): ExpandedApprovalPolicy {
  // 1. The policy's own approvers, and whoever is covering for them. Both get
  //    notified — an absent approver's cover is no use if nobody tells them.
  const notifyMap = expandDirect(policy.approvers, inputs);
  for (const delegate of expandDelegations(notifyMap, inputs.delegations)) {
    upsert(notifyMap, delegate);
  }

  // 2. Override roles: eligible, silent. Their delegates inherit both
  //    properties — a delegation carries the authority it was given, and
  //    override authority came without notifications attached.
  const overrideMap = expandDirect(
    (policy.overrideRoles ?? []).map((roleKey) => ({ kind: 'role' as const, roleKey })),
    inputs,
  );
  for (const delegate of expandDelegations(overrideMap, inputs.delegations)) {
    upsert(overrideMap, delegate);
  }

  const eligibleMap = new Map(notifyMap);
  for (const approver of overrideMap.values()) upsert(eligibleMap, approver);

  return { notify: [...notifyMap.values()], eligible: [...eligibleMap.values()] };
}

/** Is this person allowed to decide, and by what authority? */
export function findEligible(
  expanded: ExpandedApprovalPolicy,
  personId: string,
): ResolvedApprover | undefined {
  return expanded.eligible.find((approver) => approver.personId === personId);
}
