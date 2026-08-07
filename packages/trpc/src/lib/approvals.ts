import { sql, type Expression, type Kysely, type Transaction } from 'kysely';
import {
  appendEvent,
  isUniqueViolation,
  newUuidV7,
  type ApprovalDelegationRecord,
  type ApprovalRequestRecord,
  type DB,
} from '@repo/db';
import {
  activeDelegations,
  assertDelegationValid,
  evaluateApprovalThreshold,
  expandApprovalPolicy,
  findEligible,
  type ApprovalPolicyValue,
  type ApprovalThresholdValue,
  type DelegationWindow,
  type ExpandedApprovalPolicy,
  type ResolvedApprover,
  type RoleKey,
} from '@repo/domain';
import {
  approvalSubjectTypes,
  approvalsDelegationMaxDurationDays,
  approvalsReminderCadence,
  getConfig,
  qualifiedName,
  requireApprovalSubject,
  resolveConfig,
  type ApprovalSubjectDef,
} from '@repo/config';
import { cancelScheduledActions, executeTransitionIn, scheduleAction } from '@repo/workflow';
import type { ApprovalContext, WarningAck } from '../schemas.js';

/**
 * The approval engine's transactional core (core plan 09 §5.1) — the single
 * write path for `platform.approval_*` (ADR-0022), and the reason no consumer
 * ever grows a sign-off boolean of its own.
 *
 * Every mutating function here takes a `Transaction<DB>` rather than the root
 * instance, and that is the design rather than a convention: a decision, the
 * event that records it, the end of its chase and the workflow transition it
 * authorises are **one business fact**. Half of that committed alone is a
 * request marked approved with a case sitting behind it, or a chase still
 * running against something already decided. Passing the root instance is a type
 * error, so "same transaction" is structural (ADR-0010).
 *
 * ## The one idea worth holding on to
 *
 * **The policy authorises; the rows record.** `resolveApprovalPolicy` is called
 * afresh on every read and every decision — never consulted once and cached onto
 * the request — so removing someone from a role withdraws their authority over
 * every pending request immediately, with no writes and no reconfiguration
 * (PL-021 / ON AC-5). `approval_assignee` answers a different question, "who was
 * asked?", which live resolution by construction cannot.
 *
 * A reviewer's shortcut: any code here that reads `approval_assignee` to decide
 * whether someone *may act* is a bug, however reasonable it looks.
 *
 * ## What is deferred, and why it is safe
 *
 * **Plan 10 does not exist yet.** Reminder occurrences are created here on plan
 * 10's own row shape (its §4.5) through plan 07's `scheduleAction`, and
 * cancelled eagerly through `cancelScheduledActions` — exactly what core plan 08
 * did for task chases. The rows, their payloads and their journal events are
 * identical to what plan 10's `scheduleReminder`/`cancelReminders` wrappers will
 * produce, so when that plan lands it takes over the wrappers and the firing and
 * nothing is migrated: the rows simply start being executed. The **sends**
 * (`requestNotification` for assignees and the requester) wait for the same
 * plan; the journal events they will key off are emitted here already.
 */

// --- Errors ------------------------------------------------------------------

/** No such request, or none the caller may see (mapped to NOT_FOUND). */
export class ApprovalNotFoundError extends Error {
  constructor(readonly requestId: string) {
    super('No such approval request');
    this.name = 'ApprovalNotFoundError';
  }
}

/** The actor may not take this action on this request (mapped to FORBIDDEN). */
export class ApprovalForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalForbiddenError';
  }
}

/**
 * The request is no longer pending — someone else decided it first (CONFLICT).
 *
 * This is the any-one-approves race's user-facing half (PL-016 / AC-D1), so the
 * message names the outcome rather than reporting a failure: the loser of the
 * race has not done anything wrong, and the thing they wanted has happened.
 */
export class ApprovalConflictError extends Error {
  constructor(
    readonly status: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalConflictError';
  }
}

/** A request could not be opened as asked (mapped to BAD_REQUEST). */
export class ApprovalRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRequestError';
  }
}

/**
 * The decision was sound but the workflow transition it authorises was refused.
 *
 * Thrown, not returned, because it must take the decision down with it: §5.5
 * makes the approval and the case move one atomic fact, and a committed
 * approval whose case never advanced is the failure this engine exists to
 * prevent.
 */
export class ApprovalTransitionError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`the decision could not advance the case: ${detail}`);
    this.name = 'ApprovalTransitionError';
  }
}

// --- Designated approver resolvers -------------------------------------------

/**
 * A `designated` approver source: the consuming module's answer to "who are
 * *this* subject's designated approvers?" (HL-032's per-employee leave
 * approvers).
 *
 * The engine defines the interface and owns none of the answers. A resolver
 * reads a table with a real person FK — which is what makes an individual
 * end-dateable and visible to plan 16's erasure sweep, and is why the policy
 * *config value* may not name one (§4.5).
 */
export type DesignatedResolver = (
  db: Kysely<DB>,
  ctx: { subjectType: string; subjectId: string; at: Date },
) => Promise<readonly string[]>;

/**
 * The **inverse**: which subjects does this person designate-approve?
 *
 * Returned as a SQL expression yielding subject ids, not as a materialised list,
 * for two reasons. The inbox is keyset-paginated, so eligibility has to be a
 * predicate the same query can apply — a list fetched first and filtered after
 * would corrupt the page boundary (ADR-0004). And the honest answer can be large
 * (every leave booking of every employee who names me), so materialising it
 * would put an unbounded `IN` list in the query.
 *
 * This is exactly the shape core 04's `managedPersonIds` already uses for
 * record-level scope, and for the same reasons; a resolver author writing one
 * has a worked example in `lib/scope.ts`.
 */
export type DesignatedInboxScope = (viewerPersonId: string) => Expression<string>;

export interface DesignatedApproverSource {
  /** Subject → the people who may approve it. Used at read and decide time. */
  resolve: DesignatedResolver;
  /**
   * Person → the subjects they may approve, as SQL. Used by the inbox.
   *
   * **Required, deliberately.** It was optional in the first cut and that was a
   * mistake: a source registered without it resolved correctly everywhere except
   * the approvals list, so approvers could decide a request from an emailed link
   * but opened the Approvals screen to find it empty. Making it part of the
   * registration means the inbox is something you have to answer for rather than
   * something you can forget (core 09 §12.2 Q6).
   */
  inboxScope: DesignatedInboxScope;
}

const designatedResolvers = new Map<string, DesignatedApproverSource>();

function resolverKey(subjectType: string, source: string): string {
  return `${subjectType}::${source}`;
}

export function registerDesignatedResolver(
  subjectType: string,
  source: string,
  definition: DesignatedApproverSource,
): void {
  const key = resolverKey(subjectType, source);
  if (designatedResolvers.has(key)) {
    throw new Error(
      `duplicate designated approver resolver: '${source}' is already registered for '${subjectType}'`,
    );
  }
  designatedResolvers.set(key, definition);
}

/**
 * The inbox-scope expressions for a subject type's designated sources.
 *
 * Returns one expression per source the policy names; the caller ORs them into
 * that subject type's eligibility branch. An unregistered source yields nothing
 * rather than throwing — `resolveApprovalPolicy` is the place that fails loudly
 * on registry drift, and the inbox has already logged and degraded by the time
 * it would reach here.
 */
export function designatedInboxScopes(
  subjectType: string,
  sources: readonly string[],
  viewerPersonId: string,
): Expression<string>[] {
  const out: Expression<string>[] = [];
  for (const source of sources) {
    const def = designatedResolvers.get(resolverKey(subjectType, source));
    if (def) out.push(def.inboxScope(viewerPersonId));
  }
  return out;
}

/** Test-only: drop a registration so a suite can substitute a stub. */
export function unregisterDesignatedResolverForTests(subjectType: string, source: string): void {
  designatedResolvers.delete(resolverKey(subjectType, source));
}

/**
 * Every `designated` source a registered subject type **declares** has a
 * resolver registered to answer it.
 *
 * The other half of the guard `approvalPolicyValueSchemaFor` provides. That
 * schema stops a *policy* naming a source the subject type never declared; this
 * stops a subject type *declaring* one nobody implemented. Between them, the
 * only way to reach "a policy names a resolver that does not exist" is to delete
 * a registration, and this fails the build when you do.
 *
 * Asserted by a conformance test rather than at module load, because
 * registration order is a consumer's business: an HR plan registers its subject
 * type in `@repo/config` and its resolver in its own module, and requiring the
 * second to have happened by the time the first is imported would make the
 * import graph part of the contract.
 */
export function assertDesignatedResolversRegistered(): void {
  const missing: string[] = [];
  for (const subjectType of approvalSubjectTypes()) {
    for (const source of requireApprovalSubject(subjectType).designatedSources) {
      if (!designatedResolvers.has(resolverKey(subjectType, source))) {
        missing.push(`${subjectType} → '${source}'`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `approval subject types declare designated approver sources with no registered resolver: ${missing.join(', ')}. Register one with registerDesignatedResolver(), or drop the source from the subject's designatedSources.`,
    );
  }
}

// --- Reminder contract (plan 10's row shape, plan 07's timer) ----------------

/** Plan 07's effect-registry name for a reminder occurrence (plan 10 §4.5). */
export const REMINDER_ACTION_TYPE = 'notification.reminder';

/** The reminder kind plan 10 binds a satisfaction check to (its §5.5 registry). */
export const APPROVAL_REMINDER_KIND = 'approval.pending';

/** The stream a request's events and its chases hang on (ADR-0021). */
export const APPROVAL_STREAM_TYPE = 'platform.approval_request';

/**
 * The `config:` reference plan 10's handler re-resolves at each firing — built
 * from the registered key rather than written out, so a rename cannot leave
 * scheduled rows pointing at a key that no longer exists.
 */
export function reminderCadenceRef(subject: ApprovalSubjectDef): string {
  return `config:${qualifiedName(subject.reminderCadence)}`;
}

// --- Policy resolution -------------------------------------------------------

export interface ResolvedApprovalPolicy {
  subject: ApprovalSubjectDef;
  policy: ApprovalPolicyValue;
  /** The `config_entry` version in force; `null` = the frozen code default. */
  policyVersion: number | null;
  policyKey: string;
  expanded: ExpandedApprovalPolicy;
}

/** Role **keys** → ids, for the assignee rows. Definitions never hold row ids. */
async function roleIdsByKey(
  db: Kysely<DB>,
  keys: readonly RoleKey[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .selectFrom('platform.role')
    .select(['id', 'key'])
    .where('key', 'in', [...new Set(keys)])
    .where('deleted_at', 'is', null)
    .execute();
  return new Map(rows.map((row) => [row.key, row.id]));
}

/** Who currently holds each of these roles, evaluated at `at`. */
async function roleMembersAt(
  db: Kysely<DB>,
  keys: readonly RoleKey[],
  at: Date,
): Promise<Map<RoleKey, string[]>> {
  const out = new Map<RoleKey, string[]>();
  if (keys.length === 0) return out;

  // Any module: a policy names a role, not a role-in-a-module, because the
  // module an approval belongs to is a property of its subject rather than of
  // the authority to sign it off. The procedure-level `roleProcedure` still
  // gates the surface by module (the same call core plan 08 made for tasks).
  const rows = await db
    .selectFrom('platform.role_grant as g')
    .innerJoin('platform.role as r', 'r.id', 'g.role_id')
    .select(['r.key', 'g.person_id'])
    .where('r.key', 'in', [...new Set(keys)])
    .where('g.revoked_at', 'is', null)
    .where('g.deleted_at', 'is', null)
    .where('g.valid_from', '<=', at)
    .where((eb) => eb.or([eb('g.valid_until', 'is', null), eb('g.valid_until', '>', at)]))
    .execute();

  for (const row of rows) {
    const key = row.key as RoleKey;
    const list = out.get(key);
    if (list) list.push(row.person_id);
    else out.set(key, [row.person_id]);
  }
  return out;
}

/**
 * Resolve who may act on a request of this subject type, **now**.
 *
 * Called on every inbox read, every detail read and every decision — never once
 * and cached. That is the whole of §4.5: authority follows the policy and the
 * live memberships behind it, so an approver who leaves the role loses it
 * mid-request and their replacement gains it, with nothing written anywhere.
 *
 * Also exported for plan 10's `{ kind: 'policy' }` recipient resolution (§9.6),
 * so that who is *notified* and who may *act* can never be computed two
 * different ways and disagree.
 *
 * Accepts a `Transaction<DB>` as well as the root instance (a transaction is a
 * `Kysely<DB>`), which is how the decide path resolves inside the transaction
 * that records the decision.
 */
export async function resolveApprovalPolicy(
  db: Kysely<DB>,
  input: { subjectType: string; subjectId: string; at: Date },
): Promise<ResolvedApprovalPolicy> {
  const subject = requireApprovalSubject(input.subjectType);
  const resolved = await resolveConfig(db, subject.policy, { at: input.at });
  const policy = resolved.value;

  const roleKeys = [
    ...policy.approvers.filter((a) => a.kind === 'role').map((a) => a.roleKey),
    ...(policy.overrideRoles ?? []),
  ];
  const roleMembers = await roleMembersAt(db, roleKeys, input.at);

  const designatedMembers = new Map<string, readonly string[]>();
  for (const approver of policy.approvers) {
    if (approver.kind !== 'designated') continue;
    const resolver = designatedResolvers.get(resolverKey(input.subjectType, approver.source));
    if (!resolver) {
      // Registry/config drift, and loud is the only safe direction: a silently
      // empty resolver is a request that opens and notifies nobody, which reads
      // as a delivery failure rather than a configuration mistake (ADR-0016).
      throw new ApprovalRequestError(
        `the approver policy for '${input.subjectType}' names the designated source '${approver.source}', which has no registered resolver`,
      );
    }
    designatedMembers.set(
      approver.source,
      await resolver.resolve(db, {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        at: input.at,
      }),
    );
  }

  // Delegations are loaded only for people who actually hold authority here —
  // a bounded set — rather than sweeping the whole table.
  const directPersonIds = [
    ...new Set([...roleMembers.values(), ...designatedMembers.values()].flat()),
  ];
  const delegationRows =
    directPersonIds.length === 0
      ? []
      : await db
          .selectFrom('platform.approval_delegation')
          .select([
            'id',
            'delegator_person_id',
            'delegate_person_id',
            'subject_type',
            'valid_from',
            'valid_to',
            'revoked_at',
          ])
          .where('delegator_person_id', 'in', directPersonIds)
          .where('deleted_at', 'is', null)
          .execute();

  const windows: DelegationWindow[] = delegationRows.map((row) => ({
    id: row.id,
    delegatorPersonId: row.delegator_person_id,
    delegatePersonId: row.delegate_person_id,
    subjectType: row.subject_type,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    revokedAt: row.revoked_at,
  }));

  const expanded = expandApprovalPolicy(policy, {
    roleMembers,
    designatedMembers,
    delegations: activeDelegations(windows, {
      at: input.at,
      subjectType: input.subjectType,
    }),
  });

  return {
    subject,
    policy,
    policyVersion: resolved.version,
    policyKey: qualifiedName(subject.policy),
    expanded,
  };
}

// --- openApprovalRequest -----------------------------------------------------

export interface OpenApprovalRequestInput {
  subjectType: string;
  subjectId: string;
  context?: ApprovalContext;
  acknowledgedWarnings?: readonly WarningAck[];
  workflowInstanceId?: string | null;
  workflowAction?: string | null;
  /** `null` = system-raised (a timer-fired transition opened it). */
  requestedBy: string | null;
  correlationId: string;
  now: Date;
}

export type OpenApprovalResult =
  | { autoApproved: true; request: null; notified: ResolvedApprover[] }
  | { autoApproved: false; request: ApprovalRequestRecord; notified: ResolvedApprover[] };

/**
 * Open a sign-off — the shared path behind `submit` and the `approval.open`
 * workflow effect (§5.5), in one transaction.
 *
 * The order matters:
 *
 *  1. **Threshold first** (PL-018). Below it, nothing is created at all: the
 *     fact is journalled on the subject's stream as `auto_approved` and the
 *     caller is told (§12.2 Q2, resolved 2026-08-06). Creating a request nobody
 *     ever acted on would put rows with no honest actor into an append-only
 *     decision table and make every inbox count a lie.
 *  2. **Resolve the policy as-at `now`, inside this transaction**, so the
 *     request, its assignees and its event all record one consistent answer
 *     (ADR-0016).
 *  3. **Insert, journal, and schedule the chase** — together.
 *
 * A request that resolves to **nobody** is still opened. It is a real state — a
 * misconfigured policy, or a role that has emptied — and an open request with
 * zero assignees is visible and fixable, where a refusal at submit would lose
 * the user's work and tell them nothing they could act on.
 */
export async function openApprovalRequest(
  trx: Transaction<DB>,
  input: OpenApprovalRequestInput,
): Promise<OpenApprovalResult> {
  const context = input.context ?? {};
  const acknowledged = [...(input.acknowledgedWarnings ?? [])];
  const subject = requireApprovalSubject(input.subjectType);

  // 1. Does this need approval at all?
  const thresholdResolved = await resolveConfig(trx, subject.threshold, { at: input.now });
  const outcome = evaluateApprovalThreshold(
    thresholdResolved.value as ApprovalThresholdValue,
    context,
  );

  const policyResolved = await resolveApprovalPolicy(trx, {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    at: input.now,
  });

  if (!outcome.required) {
    await appendEvent(trx, {
      // The one ADR-0021 exception (§4.3): there is no request row to hang this
      // on, because the point of it is that no request was created.
      streamType: input.subjectType,
      streamId: input.subjectId,
      eventType: 'platform.approval_request.auto_approved',
      payload: {
        policyKey: policyResolved.policyKey,
        policyVersion: policyResolved.policyVersion,
        thresholdKey: qualifiedName(subject.threshold),
        thresholdVersion: thresholdResolved.version,
        reason: 'below_threshold',
        requestedBy: input.requestedBy,
        workflowInstanceId: input.workflowInstanceId ?? null,
        workflowAction: input.workflowAction ?? null,
      },
      actorPersonId: input.requestedBy,
      correlationId: input.correlationId,
    });
    return { autoApproved: true, request: null, notified: [] };
  }

  // 2. Insert the request.
  const id = newUuidV7();
  let request: ApprovalRequestRecord;
  try {
    request = await trx
      .insertInto('platform.approval_request')
      .values({
        id,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        workflow_instance_id: input.workflowInstanceId ?? null,
        workflow_action: input.workflowAction ?? null,
        requested_by: input.requestedBy,
        policy_key: policyResolved.policyKey,
        policy_version: policyResolved.policyVersion,
        context: JSON.stringify(context) as never,
        status: 'pending',
        created_by: input.requestedBy,
        updated_by: input.requestedBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (error) {
    // The partial unique index is the real guarantee, not a pre-flight SELECT
    // that would race — and it is also what makes the `approval.open` effect
    // idempotent under redelivery without a claim ledger of its own (§5.5).
    if (isUniqueViolation(error, 'approval_request_one_pending_per_subject')) {
      throw new ApprovalConflictError(
        'pending',
        'this record already has an approval request waiting for a decision',
      );
    }
    throw error;
  }

  // 3. The notification record: who the policy resolved to, and how.
  const roleIds = await roleIdsByKey(
    trx,
    policyResolved.expanded.notify
      .map((a) => a.roleKey)
      .filter((key): key is RoleKey => key !== undefined),
  );

  for (const approver of policyResolved.expanded.notify) {
    await trx
      .insertInto('platform.approval_assignee')
      .values({
        id: newUuidV7(),
        request_id: id,
        person_id: approver.personId,
        source: approver.source,
        source_role_id:
          approver.source === 'policy_role' ? (roleIds.get(approver.roleKey!) ?? null) : null,
        delegation_id: approver.delegationId ?? null,
        created_by: input.requestedBy,
      })
      .execute();
  }

  await appendEvent(trx, {
    streamType: APPROVAL_STREAM_TYPE,
    streamId: id,
    eventType: 'platform.approval_request.requested',
    payload: {
      subjectStreamType: input.subjectType,
      subjectStreamId: input.subjectId,
      policyKey: policyResolved.policyKey,
      policyVersion: policyResolved.policyVersion,
      workflowInstanceId: input.workflowInstanceId ?? null,
      workflowAction: input.workflowAction ?? null,
      requestedBy: input.requestedBy,
      assignees: policyResolved.expanded.notify.map((approver) => ({
        personId: approver.personId,
        source: approver.source,
        roleKey: approver.roleKey ?? null,
        designatedSource: approver.designatedSource ?? null,
        delegationId: approver.delegationId ?? null,
      })),
      acknowledgedWarnings: acknowledged,
    },
    actorPersonId: input.requestedBy,
    correlationId: input.correlationId,
  });

  await scheduleApprovalReminder(trx, {
    request,
    subject,
    actorPersonId: input.requestedBy,
    correlationId: input.correlationId,
    now: input.now,
  });

  return { autoApproved: false, request, notified: policyResolved.expanded.notify };
}

/**
 * Schedule the first chase for a pending request, on plan 10's contract (its
 * §4.5): a `platform.scheduled_action` row with
 * `action_type='notification.reminder'` and the payload that plan's handler
 * reads.
 *
 * Plan 10 is not built, so this goes through plan 07's `scheduleAction` rather
 * than plan 10's `scheduleReminder` wrapper — the row, its shape and its journal
 * event are identical either way, and when plan 10 lands it takes over both the
 * wrapper and the firing with nothing to migrate. Core plan 08 did the same for
 * task chases, and this plan's rows join those.
 *
 * The recipient spec is `{ kind: 'policy' }`, **not** a resolved person list:
 * plan 10 re-resolves it at each send through `resolveApprovalPolicy`, so a
 * chase after a membership change reaches the new membership (PL-021, AC-D4).
 */
async function scheduleApprovalReminder(
  trx: Transaction<DB>,
  input: {
    request: ApprovalRequestRecord;
    subject: ApprovalSubjectDef;
    actorPersonId: string | null;
    correlationId: string;
    now: Date;
  },
): Promise<void> {
  const { request } = input;
  const cadence =
    (await getConfig(trx, input.subject.reminderCadence, { at: input.now })) ??
    (await getConfig(trx, approvalsReminderCadence, { at: input.now }));

  await scheduleAction(trx, {
    dueAt: addIsoDuration(input.now, cadence),
    actionType: REMINDER_ACTION_TYPE,
    payload: {
      reminderKind: APPROVAL_REMINDER_KIND,
      sourceType: APPROVAL_STREAM_TYPE,
      sourceId: request.id,
      // Re-resolved at every send — never a person list frozen at submit.
      recipient: { kind: 'policy', policyRef: `config:${request.policy_key}` },
      subject: { streamType: request.subject_type, streamId: request.subject_id },
      cadenceRef: reminderCadenceRef(input.subject),
      occurrence: 1,
    },
    subject: { streamType: APPROVAL_STREAM_TYPE, streamId: request.id },
    workflowInstanceId: request.workflow_instance_id,
    source: 'workflow',
    createdBy: input.actorPersonId,
    correlationId: input.correlationId,
  });
}

const DAY_MS = 86_400_000;

/**
 * Add an ISO-8601 day/week duration to an instant.
 *
 * Deliberately narrow: the cadence schemas admit only `P<n>D` and `P<n>W`, so
 * there is no month or year arithmetic to get wrong here, and anything else is
 * rejected before it reaches this function.
 */
function addIsoDuration(from: Date, duration: string): Date {
  const match = /^P(\d+)([DW])$/.exec(duration);
  if (!match) {
    throw new ApprovalRequestError(
      `'${duration}' is not a supported reminder cadence — use an ISO-8601 day or week duration, e.g. P1D`,
    );
  }
  const amount = Number(match[1]);
  const days = match[2] === 'W' ? amount * 7 : amount;
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * Stop chasing, eagerly, in the transaction that settled the request — plan
 * 10's cancel-on-complete contract, step 2 (its §4.5). Its handler re-checks
 * satisfaction before every send regardless, so the worst case if this were ever
 * missed is one redundant chase, never a chase after a decision.
 */
async function cancelApprovalReminders(
  trx: Transaction<DB>,
  input: {
    requestId: string;
    reason: string;
    actorPersonId: string | null;
    correlationId: string;
  },
): Promise<void> {
  await cancelScheduledActions(trx, {
    subject: { streamType: APPROVAL_STREAM_TYPE, streamId: input.requestId },
    actionType: REMINDER_ACTION_TYPE,
    reason: input.reason,
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });
}

// --- decideApproval ----------------------------------------------------------

export interface DecideApprovalServiceInput {
  requestId: string;
  decision: 'approved' | 'rejected';
  reason?: string | null;
  acknowledgedWarnings?: readonly WarningAck[];
  actorPersonId: string;
  correlationId: string;
  now: Date;
}

export interface DecideApprovalResult {
  request: ApprovalRequestRecord;
  decisionId: string;
  /** The delegation the decider's authority came through, if any. */
  delegationId: string | null;
  /** Set when the decision fired a workflow transition (§5.5). */
  workflowAction: string | null;
}

/**
 * Record the decisive decision, and everything that follows from it, in one
 * transaction: the compare-and-set, the append-only decision row, the journal
 * event, the end of the chase, and — for a workflow-bound request — the
 * transition it authorises.
 *
 * **The any-one-approves race (PL-016 / AC-D1)** is settled by the
 * compare-and-set below rather than by a read-then-write. Two approvers pressing
 * Approve at the same moment serialise on the row: the first updates it, the
 * second's `WHERE status = 'pending'` matches nothing, and it is told the
 * request has already been decided. The unique index on
 * `approval_decision.request_id` is the structural backstop underneath.
 *
 * **Authority is re-resolved here, not trusted from the request.** The
 * eligibility check runs inside this transaction against live memberships and
 * delegations, so someone who was notified yesterday and has since left the role
 * is refused (AC-D4) — and so a caller who skipped the procedure guard still
 * cannot decide something they may not (ADR-0015, defence in depth).
 */
export async function decideApproval(
  trx: Transaction<DB>,
  input: DecideApprovalServiceInput,
): Promise<DecideApprovalResult> {
  if (input.decision === 'rejected' && (input.reason ?? '').trim().length === 0) {
    // The database CHECK would refuse this anyway; refusing here names the
    // field, which is what a form can render (PL-016).
    throw new ApprovalRequestError('a reason is required when rejecting');
  }

  // `FOR UPDATE`: two deciders racing must serialise here, or both would resolve
  // the policy from the same pre-state and each believe they had won.
  const existing = await trx
    .selectFrom('platform.approval_request')
    .selectAll()
    .where('id', '=', input.requestId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();

  if (!existing) throw new ApprovalNotFoundError(input.requestId);
  if (existing.status !== 'pending') {
    throw new ApprovalConflictError(
      existing.status,
      `this request has already been ${existing.status}`,
    );
  }

  const policyResolved = await resolveApprovalPolicy(trx, {
    subjectType: existing.subject_type,
    subjectId: existing.subject_id,
    at: input.now,
  });
  const authority = findEligible(policyResolved.expanded, input.actorPersonId);
  if (!authority) {
    throw new ApprovalForbiddenError(
      'you are not currently one of this request’s approvers — the approver policy or its role membership may have changed since it was raised',
    );
  }
  const delegationId = authority.delegationId ?? null;

  // The compare-and-set. Zero rows means someone else got there first, which
  // `FOR UPDATE` above makes vanishingly unlikely — it stays as the guarantee
  // rather than the mechanism.
  const updated = await trx
    .updateTable('platform.approval_request')
    .set({
      status: input.decision,
      decided_at: input.now,
      updated_by: input.actorPersonId,
    })
    .where('id', '=', existing.id)
    .where('status', '=', 'pending')
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    throw new ApprovalConflictError('decided', 'this request was decided by someone else first');
  }

  const decisionId = newUuidV7();
  const acknowledged = [...(input.acknowledgedWarnings ?? [])];
  await trx
    .insertInto('platform.approval_decision')
    .values({
      id: decisionId,
      request_id: existing.id,
      decision: input.decision,
      actor_person_id: input.actorPersonId,
      delegation_id: delegationId,
      reason: input.reason?.trim() || null,
      warnings_acknowledged: JSON.stringify(acknowledged) as never,
      decided_at: input.now,
      created_by: input.actorPersonId,
    })
    .execute();

  await cancelApprovalReminders(trx, {
    requestId: existing.id,
    reason: `request ${input.decision}`,
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  const subjectRefs = {
    subjectStreamType: existing.subject_type,
    subjectStreamId: existing.subject_id,
  };
  const common = {
    ...subjectRefs,
    policyKey: existing.policy_key,
    delegationId,
    acknowledgedWarnings: acknowledged,
    workflowInstanceId: existing.workflow_instance_id,
    workflowAction: existing.workflow_action,
  };

  if (input.decision === 'approved') {
    await appendEvent(trx, {
      streamType: APPROVAL_STREAM_TYPE,
      streamId: existing.id,
      eventType: 'platform.approval_request.approved',
      payload: common,
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
    });
  } else {
    await appendEvent(trx, {
      streamType: APPROVAL_STREAM_TYPE,
      streamId: existing.id,
      eventType: 'platform.approval_request.rejected',
      payload: { ...common, hasReason: true },
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
    });
  }

  // The workflow half of §5.5, in this same transaction. A guard that blocks the
  // transition takes the decision with it, which is the point: an approval whose
  // case cannot move is not an approval.
  let firedAction: string | null = null;
  if (existing.workflow_instance_id !== null && input.decision === 'approved') {
    if (existing.workflow_action !== null) {
      const result = await executeTransitionIn(trx, {
        instanceId: existing.workflow_instance_id,
        action: existing.workflow_action,
        // The runtime's `by: { system: true }` policy for engine-fired
        // transitions (§5.5): this engine's live policy resolution above **is**
        // the authorising gate, and the deciding person is on the decision row,
        // tied to the transition by `correlation_id`.
        actorPersonId: null,
        now: input.now,
        correlationId: input.correlationId,
      });
      if (!result.ok) throw new ApprovalTransitionError(result.code, result.detail);
      firedAction = existing.workflow_action;
    }
  }

  return { request: updated, decisionId, delegationId, workflowAction: firedAction };
}

// --- cancelApprovalRequest ---------------------------------------------------

export interface CancelApprovalInput {
  requestId: string;
  source: 'requester' | 'admin' | 'workflow';
  reason?: string | null;
  actorPersonId: string | null;
  correlationId: string;
  now: Date;
}

/**
 * Withdraw a pending request before anyone decides it.
 *
 * No decision row is written: nobody decided anything, and manufacturing one
 * would put a decision with no decider into an append-only table. The request's
 * terminal state and its event are the whole record.
 */
export async function cancelApprovalRequest(
  trx: Transaction<DB>,
  input: CancelApprovalInput,
): Promise<ApprovalRequestRecord> {
  const updated = await trx
    .updateTable('platform.approval_request')
    .set({
      status: 'cancelled',
      decided_at: input.now,
      updated_by: input.actorPersonId,
    })
    .where('id', '=', input.requestId)
    .where('status', '=', 'pending')
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    const existing = await trx
      .selectFrom('platform.approval_request')
      .select(['status'])
      .where('id', '=', input.requestId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!existing) throw new ApprovalNotFoundError(input.requestId);
    throw new ApprovalConflictError(
      existing.status,
      `this request has already been ${existing.status} and cannot be cancelled`,
    );
  }

  await cancelApprovalReminders(trx, {
    requestId: updated.id,
    reason: 'request cancelled',
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  await appendEvent(trx, {
    streamType: APPROVAL_STREAM_TYPE,
    streamId: updated.id,
    eventType: 'platform.approval_request.cancelled',
    payload: {
      subjectStreamType: updated.subject_type,
      subjectStreamId: updated.subject_id,
      policyKey: updated.policy_key,
      source: input.source,
      hasReason: Boolean(input.reason?.trim()),
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  return updated;
}

/**
 * Cancel whatever sign-off a workflow instance was waiting on — called when the
 * instance itself is cancelled, so a request does not outlive the case that
 * raised it (§5.5).
 */
export async function cancelApprovalsForInstance(
  trx: Transaction<DB>,
  input: {
    workflowInstanceId: string;
    actorPersonId: string | null;
    correlationId: string;
    now: Date;
  },
): Promise<number> {
  const pending = await trx
    .selectFrom('platform.approval_request')
    .select('id')
    .where('workflow_instance_id', '=', input.workflowInstanceId)
    .where('status', '=', 'pending')
    .where('deleted_at', 'is', null)
    .execute();

  for (const row of pending) {
    await cancelApprovalRequest(trx, {
      requestId: row.id,
      source: 'workflow',
      reason: 'the case this approval belonged to was cancelled',
      actorPersonId: input.actorPersonId,
      correlationId: input.correlationId,
      now: input.now,
    });
  }
  return pending.length;
}

// --- Delegations -------------------------------------------------------------

export interface CreateDelegationServiceInput {
  delegatorPersonId: string;
  delegatePersonId: string;
  subjectType?: string | null;
  validFrom: Date;
  validTo: Date;
  reason?: string | null;
  actorPersonId: string;
  correlationId: string;
  now: Date;
}

/**
 * Hand an approver's authority to someone else for a period (HL-035 driver).
 *
 * **Anyone may be a delegate** (§12.2 Q3, resolved 2026-08-06): cover for an
 * absent approver routinely means someone who holds no standing approver role,
 * and the delegation itself is what confers the authority. Administrators can
 * see and revoke any of them, and every creation is journalled `kind='security'`
 * — a delegation transfers the power to authorise, which is the same class of
 * fact as a role grant (plan 04).
 *
 * The duration ceiling is configuration, resolved here and passed into the pure
 * check, so an administrator can lengthen it without a release.
 */
export async function createDelegation(
  trx: Transaction<DB>,
  input: CreateDelegationServiceInput,
): Promise<ApprovalDelegationRecord> {
  const maxDurationDays = await getConfig(trx, approvalsDelegationMaxDurationDays, {
    at: input.now,
  });
  assertDelegationValid(
    {
      delegatorPersonId: input.delegatorPersonId,
      delegatePersonId: input.delegatePersonId,
      validFrom: input.validFrom,
      validTo: input.validTo,
    },
    { maxDurationDays },
  );

  const id = newUuidV7();
  const row = await trx
    .insertInto('platform.approval_delegation')
    .values({
      id,
      delegator_person_id: input.delegatorPersonId,
      delegate_person_id: input.delegatePersonId,
      subject_type: input.subjectType ?? null,
      valid_from: input.validFrom,
      valid_to: input.validTo,
      reason: input.reason?.trim() || null,
      created_by: input.actorPersonId,
      updated_by: input.actorPersonId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendEvent(trx, {
    kind: 'security',
    streamType: 'platform.approval_delegation',
    streamId: id,
    eventType: 'platform.approval_delegation.created',
    payload: {
      // Both parties, because the envelope's actor is whoever *created* it — an
      // administrator arranging cover is neither the delegator nor the delegate.
      delegatorPersonId: input.delegatorPersonId,
      delegatePersonId: input.delegatePersonId,
      subjectType: input.subjectType ?? null,
      validFrom: input.validFrom.toISOString(),
      validTo: input.validTo.toISOString(),
      hasReason: Boolean(input.reason?.trim()),
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  return row;
}

/**
 * End a delegation early. Non-destructive: the window stays on the row, so a
 * decision already made under it stays explainable when the journal is re-read.
 */
export async function revokeDelegation(
  trx: Transaction<DB>,
  input: {
    delegationId: string;
    actorPersonId: string;
    correlationId: string;
    now: Date;
  },
): Promise<ApprovalDelegationRecord> {
  const updated = await trx
    .updateTable('platform.approval_delegation')
    .set({ revoked_at: input.now, updated_by: input.actorPersonId })
    .where('id', '=', input.delegationId)
    .where('revoked_at', 'is', null)
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    throw new ApprovalNotFoundError(input.delegationId);
  }

  await appendEvent(trx, {
    kind: 'security',
    streamType: 'platform.approval_delegation',
    streamId: updated.id,
    eventType: 'platform.approval_delegation.revoked',
    payload: {
      delegatorPersonId: updated.delegator_person_id,
      delegatePersonId: updated.delegate_person_id,
      subjectType: updated.subject_type,
      // Revoking a window that had already lapsed changes nothing, and saying so
      // is more useful to an auditor than a bare revocation event.
      alreadyExpired: updated.valid_to.getTime() <= input.now.getTime(),
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  return updated;
}

/**
 * The SQL predicate for "this delegation is in force now".
 *
 * The same expression drives the `active` column the delegation list renders and
 * the resolver's filter, so a delegation shown as active and a delegation that
 * actually authorises cannot disagree (the data-tables rule: one expression for
 * the display, the filter and the aggregate).
 */
export const DELEGATION_ACTIVE_SQL = sql<boolean>`(
  d.revoked_at IS NULL
  AND d.deleted_at IS NULL
  AND d.valid_from <= now()
  AND d.valid_to > now()
)`;
