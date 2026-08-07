import { TRPCError } from '@trpc/server';
import { sql, type Expression, type SqlBool } from 'kysely';
import { newUuidV7 } from '@repo/db';
import { hasRole, PILOT_SIGNOFF_KEY, PILOT_SIGNOFF_SUBJECT, type RoleKey } from '@repo/domain';
import { startWorkflow } from '@repo/workflow';
import { approvalSubjectTypes, requireApprovalSubject } from '@repo/config';
import { protectedProcedure, roleProcedure, router, type TRPCContext } from '../../trpc.js';
import {
  approvalDetailSchema,
  approvalInboxInput,
  approvalInboxOutput,
  approvalRefInput,
  approvalRequestSchema,
  cancelApprovalInput,
  createDelegationInput,
  decideApprovalInput,
  listApprovalsBySubjectInput,
  listDelegationsInput,
  previewWarningsInput,
  revokeDelegationInput,
  submitApprovalInput,
  submitApprovalOutput,
  approvalDelegationSchema,
  approvalWarningSchema,
  type ApprovalContext,
} from '../../schemas.js';
import { decodeCursor, encodeCursor, keysetBoundary, timestampSortKey } from '../../lib/keyset.js';
import { collectWarnings } from '../../lib/approval-warnings.js';
import {
  cancelApprovalRequest,
  createDelegation,
  decideApproval,
  openApprovalRequest,
  resolveApprovalPolicy,
  revokeDelegation,
  ApprovalConflictError,
  ApprovalForbiddenError,
  ApprovalNotFoundError,
  ApprovalRequestError,
  ApprovalTransitionError,
  DELEGATION_ACTIVE_SQL,
} from '../../lib/approvals.js';

/**
 * The approval engine's tRPC surface (core plan 09 §5.1).
 *
 * **Live resolution is the whole model (§4.5, PL-021).** No procedure here reads
 * `approval_assignee` to decide whether someone may act: that table records who
 * was *asked*, and authority is re-computed from the policy on every read and
 * every decision. Changing a role's membership in admin therefore redirects the
 * inbox, the decision buttons and the reminders together, with no writes to any
 * approval row — reassignment is not an operation, it is a consequence.
 *
 * Every facet is SQL, eligibility included (ADR-0004). The inbox is keyset-paged,
 * so a `.filter()` over the fetched page would not merely be slow — it would
 * silently corrupt the page boundary and drop rows.
 */

/** Oversight: may see any request, cancel a stuck one, manage others' delegations. */
const OVERSIGHT_ROLES = ['administrator', 'hr_user'] as const;

/**
 * Composed once here, per the set overview's 2026-08-03 reconciliation, rather
 * than repeating the role list at each procedure.
 */
const approvalAdmin = roleProcedure(['administrator', 'hr_user'], { module: 'platform' });

function requireActor(ctx: TRPCContext): string {
  if (!ctx.actorPersonId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The acting user is not linked to a person record',
    });
  }
  return ctx.actorPersonId;
}

function hasOversight(ctx: TRPCContext, now: Date): boolean {
  return hasRole(ctx.grants, OVERSIGHT_ROLES, 'platform', now);
}

/** Service failures, mapped to the tRPC vocabulary once. */
function toTRPCError(error: unknown): unknown {
  if (error instanceof ApprovalNotFoundError) {
    return new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  if (error instanceof ApprovalForbiddenError) {
    return new TRPCError({ code: 'FORBIDDEN', message: error.message });
  }
  if (error instanceof ApprovalConflictError) {
    return new TRPCError({ code: 'CONFLICT', message: error.message });
  }
  if (error instanceof ApprovalTransitionError) {
    return new TRPCError({ code: 'CONFLICT', message: error.message });
  }
  if (error instanceof ApprovalRequestError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  if (error instanceof Error && error.name === 'DelegationWindowError') {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  if (error instanceof Error && error.name === 'ApprovalSubjectUnknownError') {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  return error;
}

/** One subject type's policy, resolved to role ids the inbox query can use. */
interface SubjectEligibility {
  subjectType: string;
  /** Roles the policy names as approvers — these people are notified. */
  roleIds: string[];
  /** Roles that may act but are never notified (HL-033). */
  overrideRoleIds: string[];
  /** True when the policy names a `designated` source (see the note below). */
  hasDesignated: boolean;
}

/**
 * Resolve every registered subject type's policy to role ids, for the inbox.
 *
 * **Why this is computed in code and pushed into the query, rather than joined
 * from `config_entry` in SQL.** A policy's value comes from the config store
 * *or*, when nobody has written an entry, from the frozen code default
 * (`@repo/config`). A pure-SQL join against `config_entry` would therefore see
 * nothing at all for every subject type still on its default — which at launch
 * is all of them — and the inbox would be silently empty. Resolving in code and
 * parameterising the predicate keeps the filter entirely server-side and inside
 * one SQL statement, which is what ADR-0004 actually requires; what it forbids
 * is filtering a page after fetching it, and nothing here does that.
 *
 * The registered subject types are a small, code-bounded set, so this is a few
 * point reads per inbox load rather than a scan.
 */
async function subjectEligibility(ctx: TRPCContext, at: Date): Promise<SubjectEligibility[]> {
  const out: SubjectEligibility[] = [];

  for (const subjectType of approvalSubjectTypes()) {
    // `subjectId` is irrelevant to the role half of a policy, and the designated
    // half is deliberately not resolved here — see the note on `hasDesignated`.
    const subject = requireApprovalSubject(subjectType);
    let resolved: Awaited<ReturnType<typeof resolveApprovalPolicy>> | null = null;
    try {
      resolved = await resolveApprovalPolicy(ctx.db, {
        subjectType,
        subjectId: '00000000-0000-0000-0000-000000000000',
        at,
      });
    } catch (error) {
      // One broken subject type must not take down the whole inbox — the other
      // types' requests are still perfectly readable. But it must not vanish
      // **quietly** either: this branch drops every request of that type out of
      // everyone's queue, which looks exactly like "no approvals today" and is
      // the worst way for a configuration fault to present.
      ctx.logger.error(
        'approval policy could not be resolved; its requests are absent from the inbox',
        {
          subjectType,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      out.push({
        subjectType,
        roleIds: [],
        overrideRoleIds: [],
        hasDesignated: subject.designatedSources.length > 0,
      });
      continue;
    }

    const roleKeys = resolved.policy.approvers
      .filter((a) => a.kind === 'role')
      .map((a) => a.roleKey);
    const overrideKeys = resolved.policy.overrideRoles ?? [];
    const ids = await roleIdsFor(ctx, [...roleKeys, ...overrideKeys]);

    out.push({
      subjectType,
      roleIds: roleKeys.map((k) => ids.get(k)).filter((id): id is string => id !== undefined),
      overrideRoleIds: overrideKeys
        .map((k) => ids.get(k))
        .filter((id): id is string => id !== undefined),
      hasDesignated: resolved.policy.approvers.some((a) => a.kind === 'designated'),
    });
  }

  return out;
}

async function roleIdsFor(
  ctx: TRPCContext,
  keys: readonly RoleKey[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await ctx.db
    .selectFrom('platform.role')
    .select(['id', 'key'])
    .where('key', 'in', [...new Set(keys)])
    .where('deleted_at', 'is', null)
    .execute();
  return new Map(rows.map((row) => [row.key, row.id]));
}

/**
 * "May this viewer act on this request?", as a SQL predicate.
 *
 * Three routes, matching the three `approval_assignee.source` values that can
 * confer authority — a role the policy names, a role it names as an override,
 * and a delegation from someone holding either.
 *
 * `designated` approvers are **not** covered: a designated source is a
 * consumer-registered function over a subject *instance*, and there is no way to
 * express "call this TypeScript function" in a WHERE clause. No Phase 1 subject
 * type uses one (§12.1: the pilot uses role kinds only), and the seam the first
 * HR consumer must close is recorded as §12.2 Q6 rather than left to be
 * discovered when a designated approver's inbox turns up empty.
 */
function eligibilitySql(
  viewerPersonId: string,
  eligibility: readonly SubjectEligibility[],
  includeOverride: boolean,
): Expression<SqlBool> {
  const branches = eligibility
    .map((entry) => {
      const actingRoleIds = includeOverride
        ? [...entry.roleIds, ...entry.overrideRoleIds]
        : entry.roleIds;
      if (actingRoleIds.length === 0) return null;

      const roleIdList = sql.join(actingRoleIds.map((id) => sql`${id}::uuid`));
      return sql<SqlBool>`(
        r.subject_type = ${entry.subjectType}
        AND (
          EXISTS (
            SELECT 1 FROM platform.role_grant g
            WHERE g.person_id = ${viewerPersonId}
              AND g.role_id IN (${roleIdList})
              AND g.revoked_at IS NULL AND g.deleted_at IS NULL
              AND g.valid_from <= now()
              AND (g.valid_until IS NULL OR g.valid_until > now())
          )
          OR EXISTS (
            SELECT 1 FROM platform.approval_delegation d
            JOIN platform.role_grant dg ON dg.person_id = d.delegator_person_id
            WHERE d.delegate_person_id = ${viewerPersonId}
              AND (d.subject_type IS NULL OR d.subject_type = r.subject_type)
              AND d.revoked_at IS NULL AND d.deleted_at IS NULL
              AND d.valid_from <= now() AND d.valid_to > now()
              AND dg.role_id IN (${roleIdList})
              AND dg.revoked_at IS NULL AND dg.deleted_at IS NULL
              AND dg.valid_from <= now()
              AND (dg.valid_until IS NULL OR dg.valid_until > now())
          )
        )
      )`;
    })
    .filter((branch): branch is Exclude<typeof branch, null> => branch !== null);

  // No registered subject type resolves to a role this viewer could hold: the
  // honest answer is an empty inbox, and `false` says so without a scan.
  if (branches.length === 0) return sql<SqlBool>`false`;
  return sql<SqlBool>`(${sql.join(branches, sql` OR `)})`;
}

/** Whole days a request has been outstanding — one expression, used everywhere. */
const WAITING_DAYS_SQL = sql<number>`
  GREATEST(0, (EXTRACT(EPOCH FROM (coalesce(r.decided_at, now()) - r.created_at)) / 86400)::int)
`;

/**
 * The sort key for `sort='decided'`.
 *
 * `decided_at` is null while a request is pending, and a null sort key breaks
 * the row-value cursor comparison outright, so pending requests coalesce to a
 * far-future sentinel — they sort last ascending, which is also where a history
 * view wants them. Fixed-width so microsecond precision survives the cursor
 * round trip (ADR-0004; a JS `Date` holds only milliseconds).
 */
const DECIDED_SORT_KEY = sql<string>`to_char(
  coalesce(r.decided_at, timestamptz '9999-12-31 00:00:00+00'),
  'YYYY-MM-DD"T"HH24:MI:SS.US'
)`;

/** The `context` column comes back as `Json`; the schema types it as scalars. */
function asContext(value: unknown): ApprovalContext {
  return (value ?? {}) as ApprovalContext;
}

export const approvalsRouter = router({
  /**
   * Warnings for the requester **before** they commit to submitting (PL-017).
   *
   * Read-only and never blocking: the point is that someone raising a leave
   * request sees "two colleagues are already off that week" while they can still
   * change their mind, not after.
   */
  previewWarnings: protectedProcedure
    .input(previewWarningsInput)
    .output(approvalWarningSchema.array())
    .query(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      return collectWarnings(
        {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          requestedBy: actorPersonId,
          context: input.context,
          audience: 'requester',
          viewerPersonId: actorPersonId,
          db: ctx.db,
          now: new Date(),
        },
        ctx.logger,
      );
    }),

  /**
   * Open a standalone sign-off (§5.5's second entry point). Workflow-bound
   * requests are opened server-side by the `approval.open` effect.
   */
  submit: protectedProcedure
    .input(submitApprovalInput)
    .output(submitApprovalOutput)
    .mutation(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      try {
        const result = await ctx.db.transaction().execute((trx) =>
          openApprovalRequest(trx, {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            context: input.context,
            acknowledgedWarnings: input.acknowledgedWarnings,
            requestedBy: actorPersonId,
            correlationId: ctx.correlationId,
            now: new Date(),
          }),
        );
        return {
          requestId: result.request?.id ?? null,
          status: result.request?.status ?? null,
          autoApproved: result.autoApproved,
          notifiedCount: result.notified.length,
        };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /**
   * Record the decisive decision (PL-016).
   *
   * The eligibility check and the compare-and-set both live in the service,
   * inside the transaction, so a caller who reached this another way still
   * cannot decide something they may not (ADR-0015, defence in depth) and two
   * racing approvers still yield exactly one decision.
   */
  decide: protectedProcedure.input(decideApprovalInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    try {
      const result = await ctx.db.transaction().execute((trx) =>
        decideApproval(trx, {
          requestId: input.requestId,
          decision: input.decision,
          reason: input.reason ?? null,
          acknowledgedWarnings: input.acknowledgedWarnings,
          actorPersonId,
          correlationId: ctx.correlationId,
          now: new Date(),
        }),
      );
      return {
        status: result.request.status,
        decisionId: result.decisionId,
        delegationId: result.delegationId,
        workflowAction: result.workflowAction,
      };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** Withdraw a pending request — the requester, or oversight for a stuck one. */
  cancel: protectedProcedure.input(cancelApprovalInput).mutation(async ({ ctx, input }) => {
    const actorPersonId = requireActor(ctx);
    const now = new Date();
    const oversight = hasOversight(ctx, now);

    const request = await ctx.db
      .selectFrom('platform.approval_request')
      .select(['id', 'requested_by'])
      .where('id', '=', input.requestId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    // NOT_FOUND rather than FORBIDDEN when the caller is neither: a distinct
    // refusal would confirm the request exists.
    if (!request || !(oversight || request.requested_by === actorPersonId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No such approval request' });
    }

    try {
      const updated = await ctx.db.transaction().execute((trx) =>
        cancelApprovalRequest(trx, {
          requestId: input.requestId,
          source: request.requested_by === actorPersonId ? 'requester' : 'admin',
          reason: input.reason ?? null,
          actorPersonId,
          correlationId: ctx.correlationId,
          now,
        }),
      );
      return { status: updated.status };
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /**
   * The caller's approvals inbox — requests they may act on **now**.
   *
   * `protectedProcedure` with no role list, deliberately: the surface is
   * self-scoping. Which requests a person sees *is* the policy resolution over
   * their live grants and delegations, so there is no role that could be
   * required beyond having some.
   */
  inbox: protectedProcedure
    .input(approvalInboxInput)
    .output(approvalInboxOutput)
    .query(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const now = new Date();
      const eligibility = await subjectEligibility(ctx, now);
      const sortKey =
        input.sort === 'decided' ? DECIDED_SORT_KEY : timestampSortKey('r.created_at');

      let query = ctx.db
        .selectFrom('platform.approval_request as r')
        .leftJoin('platform.person as p', 'p.id', 'r.requested_by')
        .select([
          'r.id',
          'r.subject_type',
          'r.subject_id',
          'r.status',
          'r.policy_key',
          'r.requested_by',
          'p.display_name as requested_by_name',
          'r.created_at',
          'r.decided_at',
        ])
        .select(WAITING_DAYS_SQL.as('waiting_days'))
        .select(sortKey.as('sort_key'))
        // Whether this row reached the viewer only through an override role, and
        // through which delegation — computed in the same query as the filter,
        // so the badge on a row and the reason it is there cannot disagree.
        .select(
          sql<boolean>`NOT (${eligibilitySql(actorPersonId, eligibility, false)})`.as(
            'via_override',
          ),
        )
        .select(
          sql<string | null>`(
            SELECT d.id FROM platform.approval_delegation d
            WHERE d.delegate_person_id = ${actorPersonId}
              AND (d.subject_type IS NULL OR d.subject_type = r.subject_type)
              AND d.revoked_at IS NULL AND d.deleted_at IS NULL
              AND d.valid_from <= now() AND d.valid_to > now()
            ORDER BY d.valid_from DESC
            LIMIT 1
          )`.as('via_delegation_id'),
        )
        .where('r.deleted_at', 'is', null)
        .where(eligibilitySql(actorPersonId, eligibility, input.includeOverride));

      // Default to the outstanding set: an inbox of everything ever decided is a
      // report, not a list of what someone needs to do.
      query = query.where('r.status', 'in', input.status ?? ['pending']);
      if (input.subjectType) query = query.where('r.subject_type', '=', input.subjectType);

      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (cursor) query = query.where(keysetBoundary(sortKey, 'r.id', cursor, input.sortDir));
      }

      const rows = await query
        .orderBy(sortKey, input.sortDir)
        .orderBy('r.id', input.sortDir)
        .limit(input.limit + 1)
        .execute();

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);

      return {
        items: items.map((row) => ({
          id: row.id,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          status: row.status,
          policyKey: row.policy_key,
          requestedBy: row.requested_by,
          requestedByName: row.requested_by_name,
          submittedAt: row.created_at.toISOString(),
          decidedAt: row.decided_at?.toISOString() ?? null,
          waitingDays: Number(row.waiting_days),
          viaOverride: row.via_override,
          viaDelegationId: row.via_delegation_id,
        })),
        nextCursor: hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null,
      };
    }),

  /**
   * One request: the row, who was asked, the decision, and **live** warnings.
   *
   * `viewerCanDecide` is re-computed from the policy on every read (§4.5), which
   * is why the decision screen can honestly disable its buttons for someone who
   * was notified yesterday and has since left the role — and say why.
   */
  byId: protectedProcedure
    .input(approvalRefInput)
    .output(approvalDetailSchema)
    .query(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const now = new Date();

      const request = await ctx.db
        .selectFrom('platform.approval_request as r')
        .leftJoin('platform.person as p', 'p.id', 'r.requested_by')
        .select([
          'r.id',
          'r.subject_type',
          'r.subject_id',
          'r.status',
          'r.policy_key',
          'r.policy_version',
          'r.workflow_instance_id',
          'r.workflow_action',
          'r.requested_by',
          'p.display_name as requested_by_name',
          'r.context',
          'r.created_at',
          'r.decided_at',
        ])
        .where('r.id', '=', input.requestId)
        .where('r.deleted_at', 'is', null)
        .executeTakeFirst();

      if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such approval request' });

      const resolved = await resolveApprovalPolicy(ctx.db, {
        subjectType: request.subject_type,
        subjectId: request.subject_id,
        at: now,
      }).catch(() => null);

      const authority = resolved?.expanded.eligible.find((a) => a.personId === actorPersonId);
      const isRequester = request.requested_by === actorPersonId;
      const oversight = hasOversight(ctx, now);

      // Visible to the requester, anyone who may act, and oversight. NOT_FOUND
      // rather than FORBIDDEN for everyone else, as elsewhere.
      if (!authority && !isRequester && !oversight) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such approval request' });
      }

      const assignees = await ctx.db
        .selectFrom('platform.approval_assignee as a')
        .leftJoin('platform.person as ap', 'ap.id', 'a.person_id')
        .leftJoin('platform.role as ar', 'ar.id', 'a.source_role_id')
        .select([
          'a.person_id',
          'ap.display_name as person_name',
          'a.source',
          'ar.name as role_name',
          'a.delegation_id',
          'a.notified_at',
        ])
        .where('a.request_id', '=', request.id)
        .orderBy('a.created_at')
        .execute();

      const decision = await ctx.db
        .selectFrom('platform.approval_decision as d')
        .leftJoin('platform.person as dp', 'dp.id', 'd.actor_person_id')
        .leftJoin('platform.approval_delegation as dl', 'dl.id', 'd.delegation_id')
        .leftJoin('platform.person as ol', 'ol.id', 'dl.delegator_person_id')
        .select([
          'd.id',
          'd.decision',
          'd.actor_person_id',
          'dp.display_name as actor_name',
          'd.delegation_id',
          'ol.display_name as on_behalf_of_name',
          'd.reason',
          'd.warnings_acknowledged',
          'd.decided_at',
        ])
        .where('d.request_id', '=', request.id)
        .executeTakeFirst();

      const warnings = await collectWarnings(
        {
          subjectType: request.subject_type,
          subjectId: request.subject_id,
          requestedBy: request.requested_by,
          context: asContext(request.context),
          audience: authority ? 'approver' : 'requester',
          viewerPersonId: actorPersonId,
          db: ctx.db,
          now,
        },
        ctx.logger,
      );

      const cannotDecideReason = authority
        ? request.status !== 'pending'
          ? request.status === 'cancelled'
            ? ('cancelled' as const)
            : ('already_decided' as const)
          : null
        : ('not_eligible' as const);

      return {
        request: {
          id: request.id,
          subjectType: request.subject_type,
          subjectId: request.subject_id,
          status: request.status,
          policyKey: request.policy_key,
          policyVersion: request.policy_version,
          workflowInstanceId: request.workflow_instance_id,
          workflowAction: request.workflow_action,
          requestedBy: request.requested_by,
          requestedByName: request.requested_by_name,
          context: asContext(request.context),
          submittedAt: request.created_at.toISOString(),
          decidedAt: request.decided_at?.toISOString() ?? null,
        },
        assignees: assignees.map((a) => ({
          personId: a.person_id,
          personName: a.person_name,
          source: a.source,
          roleName: a.role_name,
          delegationId: a.delegation_id,
          notifiedAt: a.notified_at?.toISOString() ?? null,
        })),
        decision: decision
          ? {
              id: decision.id,
              decision: decision.decision,
              actorPersonId: decision.actor_person_id,
              actorName: decision.actor_name,
              delegationId: decision.delegation_id,
              onBehalfOfName: decision.on_behalf_of_name,
              reason: decision.reason,
              acknowledgedWarnings: Array.isArray(decision.warnings_acknowledged)
                ? (decision.warnings_acknowledged as { provider: string; code: string }[])
                : [],
              decidedAt: decision.decided_at.toISOString(),
            }
          : null,
        warnings,
        viewerCanDecide: Boolean(authority) && request.status === 'pending',
        viewerDelegationId: authority?.delegationId ?? null,
        viewerCannotDecideReason: cannotDecideReason,
      };
    }),

  /** Every request raised against one record — the "approvals" panel's read. */
  listBySubject: protectedProcedure
    .input(listApprovalsBySubjectInput)
    .output(approvalRequestSchema.array())
    .query(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const now = new Date();

      const resolved = await resolveApprovalPolicy(ctx.db, {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        at: now,
      }).catch(() => null);
      const mayAct = Boolean(resolved?.expanded.eligible.some((a) => a.personId === actorPersonId));

      const rows = await ctx.db
        .selectFrom('platform.approval_request as r')
        .leftJoin('platform.person as p', 'p.id', 'r.requested_by')
        .select([
          'r.id',
          'r.subject_type',
          'r.subject_id',
          'r.status',
          'r.policy_key',
          'r.policy_version',
          'r.workflow_instance_id',
          'r.workflow_action',
          'r.requested_by',
          'p.display_name as requested_by_name',
          'r.context',
          'r.created_at',
          'r.decided_at',
        ])
        .where('r.subject_type', '=', input.subjectType)
        .where('r.subject_id', '=', input.subjectId)
        .where('r.deleted_at', 'is', null)
        .$if(!mayAct && !hasOversight(ctx, now), (qb) =>
          // Not an approver and not oversight: you see the requests you raised.
          qb.where('r.requested_by', '=', actorPersonId),
        )
        .orderBy('r.created_at', 'desc')
        .execute();

      return rows.map((row) => ({
        id: row.id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        status: row.status,
        policyKey: row.policy_key,
        policyVersion: row.policy_version,
        workflowInstanceId: row.workflow_instance_id,
        workflowAction: row.workflow_action,
        requestedBy: row.requested_by,
        requestedByName: row.requested_by_name,
        context: asContext(row.context),
        submittedAt: row.created_at.toISOString(),
        decidedAt: row.decided_at?.toISOString() ?? null,
      }));
    }),

  delegations: router({
    /** Own delegations, or — for oversight — anyone's. */
    list: protectedProcedure
      .input(listDelegationsInput)
      .output(approvalDelegationSchema.array())
      .query(async ({ ctx, input }) => {
        const actorPersonId = requireActor(ctx);
        const target = input.personId ?? actorPersonId;

        if (target !== actorPersonId && !hasOversight(ctx, new Date())) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'you can only view your own delegations',
          });
        }

        const rows = await ctx.db
          .selectFrom('platform.approval_delegation as d')
          .leftJoin('platform.person as dr', 'dr.id', 'd.delegator_person_id')
          .leftJoin('platform.person as de', 'de.id', 'd.delegate_person_id')
          .select([
            'd.id',
            'd.delegator_person_id',
            'dr.display_name as delegator_name',
            'd.delegate_person_id',
            'de.display_name as delegate_name',
            'd.subject_type',
            'd.valid_from',
            'd.valid_to',
            'd.revoked_at',
            'd.reason',
          ])
          .select(DELEGATION_ACTIVE_SQL.as('active'))
          .where('d.deleted_at', 'is', null)
          // Both directions: authority this person gave away, and authority they
          // are currently carrying. Someone covering for a colleague needs to see
          // it as much as the person who arranged it.
          .where((eb) =>
            eb.or([
              eb('d.delegator_person_id', '=', target),
              eb('d.delegate_person_id', '=', target),
            ]),
          )
          .$if(!input.includeInactive, (qb) => qb.where(DELEGATION_ACTIVE_SQL))
          .orderBy('d.valid_from', 'desc')
          .execute();

        return rows.map((row) => ({
          id: row.id,
          delegatorPersonId: row.delegator_person_id,
          delegatorName: row.delegator_name,
          delegatePersonId: row.delegate_person_id,
          delegateName: row.delegate_name,
          subjectType: row.subject_type,
          validFrom: row.valid_from.toISOString(),
          validTo: row.valid_to.toISOString(),
          revokedAt: row.revoked_at?.toISOString() ?? null,
          reason: row.reason,
          active: row.active,
        }));
      }),

    /**
     * Delegate your own authority — or, for oversight, arrange cover for an
     * absent approver who cannot do it themselves (HL-035).
     */
    create: protectedProcedure.input(createDelegationInput).mutation(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);
      const delegator = input.delegatorPersonId ?? actorPersonId;

      if (delegator !== actorPersonId && !hasOversight(ctx, new Date())) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'only an administrator can delegate someone else’s approvals',
        });
      }

      try {
        const row = await ctx.db.transaction().execute((trx) =>
          createDelegation(trx, {
            delegatorPersonId: delegator,
            delegatePersonId: input.delegatePersonId,
            subjectType: input.subjectType ?? null,
            validFrom: new Date(input.validFrom),
            validTo: new Date(input.validTo),
            reason: input.reason ?? null,
            actorPersonId,
            correlationId: ctx.correlationId,
            now: new Date(),
          }),
        );
        return { delegationId: row.id };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

    /** End one early. Non-destructive — the window stays on the row. */
    revoke: protectedProcedure.input(revokeDelegationInput).mutation(async ({ ctx, input }) => {
      const actorPersonId = requireActor(ctx);

      const existing = await ctx.db
        .selectFrom('platform.approval_delegation')
        .select(['id', 'delegator_person_id'])
        .where('id', '=', input.delegationId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (
        !existing ||
        !(existing.delegator_person_id === actorPersonId || hasOversight(ctx, new Date()))
      ) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such delegation' });
      }

      try {
        const row = await ctx.db.transaction().execute((trx) =>
          revokeDelegation(trx, {
            delegationId: input.delegationId,
            actorPersonId,
            correlationId: ctx.correlationId,
            now: new Date(),
          }),
        );
        return { revokedAt: row.revoked_at?.toISOString() ?? null };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
  }),

  /**
   * Start a pilot sign-off case (core plan 09 §9.8) — the demo slice's entry
   * point, and the **workflow-bound** half of §5.5.
   *
   * The engine is generic, so demonstrating it needs *some* case, and Phase 1
   * has no HR module to supply one. This mints a synthetic subject and starts
   * the `platform.pilot.signoff` workflow against it; taking that workflow's
   * `submit` transition (through the generic `platform.workflow.transition`) is
   * what opens the approval request via the `approval.open` effect, and the
   * decisive decision fires `approve` back the other way — atomically with the
   * decision (AC-D7).
   *
   * Demo-only, and it retires with the pilot shape.
   */
  startPilotSignoff: approvalAdmin.mutation(async ({ ctx }) => {
    const actorPersonId = requireActor(ctx);
    const streamId = newUuidV7();
    const { instance } = await ctx.db.transaction().execute((trx) =>
      startWorkflow(trx, {
        workflowKey: PILOT_SIGNOFF_KEY,
        subject: { streamType: PILOT_SIGNOFF_SUBJECT, streamId },
        actorPersonId,
        now: new Date(),
        correlationId: ctx.correlationId,
      }),
    );
    return {
      instanceId: instance.id,
      subjectType: PILOT_SIGNOFF_SUBJECT,
      subjectId: streamId,
      state: instance.current_state,
    };
  }),

  /**
   * Every subject type approvals are enabled on, with its resolved policy —
   * the admin surface's "what can be approved, and by whom?".
   *
   * **This is where a broken policy surfaces.** A subject type whose policy
   * cannot be resolved drops out of everyone's inbox (the eligibility query
   * fails closed), so the fault has to be visible *somewhere* an administrator
   * looks — and this is that screen. Each row carries its own `error` rather
   * than the query failing, because one broken type must not hide the others.
   */
  subjects: approvalAdmin.query(async ({ ctx }) => {
    const now = new Date();
    const out = [];
    for (const subjectType of approvalSubjectTypes()) {
      const subject = requireApprovalSubject(subjectType);
      let resolved: Awaited<ReturnType<typeof resolveApprovalPolicy>> | null = null;
      let error: string | null = null;
      try {
        resolved = await resolveApprovalPolicy(ctx.db, {
          subjectType,
          subjectId: '00000000-0000-0000-0000-000000000000',
          at: now,
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      out.push({
        subjectType,
        policyKey: `${subject.policy.namespace}.${subject.policy.key}`,
        thresholdKey: `${subject.threshold.namespace}.${subject.threshold.key}`,
        designatedSources: [...subject.designatedSources],
        approvers: resolved?.policy.approvers ?? [],
        overrideRoles: resolved?.policy.overrideRoles ?? [],
        /** Non-null when this subject type's approvals are currently broken. */
        error,
      });
    }
    return out;
  }),
});
