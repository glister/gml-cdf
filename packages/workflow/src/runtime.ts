import type { Kysely, Transaction } from 'kysely';
import { getConfig, parseConfigRef } from '@repo/config';
import {
  appendEvent,
  isUniqueViolation,
  loadGrantsForPerson,
  newUuidV7,
  type DB,
  type WorkflowInstanceRecord,
  type WorkflowTransitionRecord,
} from '@repo/db';
import {
  configRefsFor,
  evaluateTransition,
  guardRegistry,
  hasRole,
  latestDefinition,
  requireDefinition,
  scheduleConfigRefs,
  type EventPayload,
  type GuardWarning,
  type ModuleKey,
  type RoleKey,
  type TransitionActorPolicy,
  type WorkflowDefinition,
} from '@repo/domain';
import { cancelScheduledActions, scheduleRefs } from './scheduled-actions.js';
import { requireSubjectLoader } from './subjects.js';

/**
 * The workflow runtime (core plan 07 §5.2, WF-2/4/6/10) — the orchestration
 * layer that turns a declarative definition into committed state.
 *
 * Everything that decides is pure and lives in `@repo/domain`; everything that
 * *acts* is here (ADR-0009). This module resolves configuration as-at, checks
 * the actor against a role policy, loads the subject, and — in **one
 * transaction** — writes the state, the append-only transition row and the
 * journal event, cancels superseded timers and creates new ones.
 *
 * ## Why the two entry points take different first arguments
 *
 * `startWorkflow` takes a `Transaction<DB>` because an instance almost always
 * comes into existence alongside its subject: a leave booking row and the
 * approval case that governs it must commit together, or a request exists that
 * nothing is driving. Forcing the caller's transaction in makes that structural.
 *
 * `executeTransition` takes the root `Kysely<DB>` and owns its transaction,
 * because the transaction boundary *is* the semantics: it takes the row lock
 * that serialises concurrent actors, and a blocked guard must roll back to
 * leaving **nothing** behind — including any writes a caller had already made.
 * A caller that needs to write alongside a transition registers an effect.
 */

/**
 * The payload shape shared by the generic `transitioned` event and by every
 * domain-specific `emits` override — the runtime builds exactly this, whatever
 * the fact ends up being called (§4.2).
 */
type TransitionedPayload = EventPayload<'platform.workflow_instance.transitioned'>;

/** `platform.workflow.*` failure codes, mapped to tRPC codes at the boundary. */
export type TransitionFailureCode =
  /** The case moved under you — a stale timer, or a second approver. */
  | 'CONFLICT'
  /** The actor does not satisfy the transition's `by` policy. */
  | 'FORBIDDEN'
  /** A hard guard rejected it; nothing was written. */
  | 'GUARD_BLOCKED'
  /** No such action on the pinned definition version. */
  | 'UNKNOWN_ACTION'
  /** No such instance (or it is soft-deleted). */
  | 'NOT_FOUND';

export interface TransitionSuccess {
  ok: true;
  instance: WorkflowInstanceRecord;
  transition: WorkflowTransitionRecord;
  /** Soft-guard warnings, surfaced to the caller (PL-017). */
  warnings: GuardWarning[];
}

export interface TransitionFailure {
  ok: false;
  code: TransitionFailureCode;
  detail: string;
}

export type TransitionResult = TransitionSuccess | TransitionFailure;

/** Thrown when a subject already has an active instance of this workflow. */
export class WorkflowAlreadyActiveError extends Error {
  constructor(
    readonly workflowKey: string,
    readonly streamType: string,
    readonly streamId: string,
  ) {
    super(
      `'${workflowKey}' already has an active instance for ${streamType}/${streamId} — complete or cancel it before starting another`,
    );
    this.name = 'WorkflowAlreadyActiveError';
  }
}

/**
 * Resolve a set of `config:` references as-at `at`, keyed by qualified name.
 *
 * `at` is the transition's business time, and the read runs on the caller's
 * transaction — so the transition row, its journal event and the values it acted
 * on are mutually consistent, and re-reading the journal later with the same
 * instant reproduces the decision exactly however many times the configuration
 * has moved since (ADR-0016).
 */
async function resolveRefs(
  trx: Transaction<DB>,
  refs: readonly string[],
  at: Date,
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};
  for (const ref of refs) {
    const def = parseConfigRef(ref);
    const name = `${def.namespace}.${def.key}`;
    resolved[name] = await getConfig(trx, def, { at });
  }
  return resolved;
}

/** The role keys a `by` policy admits, given the already-resolved config. */
function rolesFor(
  by: TransitionActorPolicy,
  config: Readonly<Record<string, unknown>>,
): RoleKey[] | 'system' {
  if ('system' in by) return 'system';
  if ('role' in by) return [by.role as RoleKey];

  const name = by.configRef.slice('config:'.length);
  const value = config[name];
  // A policy may resolve to one role or several ("any one of the designated
  // approvers", HL AC-6). Anything else is a misconfigured key, and returning an
  // empty list fails **closed** — nobody may act until it is fixed.
  if (typeof value === 'string') return [value as RoleKey];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as RoleKey[];
  }
  return [];
}

export interface StartWorkflowInput {
  workflowKey: string;
  subject: { streamType: string; streamId: string };
  /** An instance is always started on behalf of a real person (§4.1). */
  actorPersonId: string;
  now: Date;
  correlationId: string;
}

/**
 * Create an instance, pinned to the **latest** registered version of its
 * definition (WF-4), emit `platform.workflow_instance.started`, and create the
 * timers the definition's `initialSchedule` declares.
 *
 * Pinning at start is what makes a rule change safe: registering v2 tomorrow
 * changes nothing for a case already running, exactly as ON-006 snapshots the
 * rules a starter was onboarded under.
 */
export async function startWorkflow(
  trx: Transaction<DB>,
  input: StartWorkflowInput,
): Promise<{ instance: WorkflowInstanceRecord; definition: WorkflowDefinition }> {
  const def = latestDefinition(input.workflowKey);
  const id = newUuidV7();

  let instance: WorkflowInstanceRecord;
  try {
    instance = await trx
      .insertInto('platform.workflow_instance')
      .values({
        id,
        workflow_key: def.key,
        definition_version: def.version,
        subject_stream_type: input.subject.streamType,
        subject_stream_id: input.subject.streamId,
        current_state: def.initial,
        created_by: input.actorPersonId,
        updated_by: input.actorPersonId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (error) {
    // The partial unique index is the real guarantee against two active
    // instances for one subject — a pre-flight SELECT would race.
    if (isUniqueViolation(error, 'workflow_instance_active_subject_uq')) {
      throw new WorkflowAlreadyActiveError(
        def.key,
        input.subject.streamType,
        input.subject.streamId,
      );
    }
    throw error;
  }

  await appendEvent(trx, {
    streamType: 'platform.workflow_instance',
    streamId: id,
    eventType: 'platform.workflow_instance.started',
    payload: {
      workflowKey: def.key,
      definitionVersion: def.version,
      subjectStreamType: input.subject.streamType,
      subjectStreamId: input.subject.streamId,
      initialState: def.initial,
    },
    actorPersonId: input.actorPersonId,
    correlationId: input.correlationId,
  });

  if (def.initialSchedule?.length) {
    const config = await resolveRefs(trx, scheduleConfigRefs(def.initialSchedule), input.now);
    await scheduleRefs(trx, def.initialSchedule, {
      anchor: input.now,
      config,
      subject: input.subject,
      workflowInstanceId: id,
      enteringState: def.initial,
      createdBy: input.actorPersonId,
      correlationId: input.correlationId,
    });
  }

  return { instance, definition: def };
}

export interface ExecuteTransitionInput {
  instanceId: string;
  action: string;
  /** `null` = the system acting: a timer, a sweep, automation. */
  actorPersonId: string | null;
  onBehalfOf?: string | null;
  comment?: string | null;
  input?: Record<string, unknown>;
  /**
   * Optimistic concurrency check. Timers and automation pass the state they
   * believed the instance was in; a mismatch is a `CONFLICT` and, for the
   * built-in timer handler, a recorded no-op rather than an error (§5.4).
   */
  expectedState?: string;
  now: Date;
  correlationId: string;
}

/**
 * Execute a named action against an instance — the whole of §5.2, in one
 * transaction.
 *
 * The order is deliberate and each step earns its place:
 *
 *  1. **`SELECT … FOR UPDATE`** on the instance. This is what makes WF-10 true:
 *     two approvers racing serialise here, the second reads the state the first
 *     committed, and gets `CONFLICT` instead of writing a second transition.
 *  2. **Cheap rejections before expensive work** — `expectedState`, then whether
 *     the pinned definition even has this `(state, action)`. A rejected
 *     transition is not a business fact and writes nothing; it is logged, not
 *     journalled. Doing this first also avoids resolving configuration for a
 *     transition that was never going to happen.
 *  3. **Resolve config as-at `now`, then check the actor.** Both before the
 *     subject load, because `FORBIDDEN` should not depend on a subject query.
 *  4. **Load the subject, then evaluate purely.** A hard guard rolls the whole
 *     transaction back — "writes nothing" is enforced by the transaction, not by
 *     remembering not to write.
 *  5. **State + transition row + journal event**, together (ADR-0010).
 *  6. **Terminal ⇒ cancel this instance's pending timers**; the taken transition's
 *     own `schedule` refs become new ones.
 *
 * Effects are *not* sent here. They ride the outbox: the journal event carries
 * them and the relay fans them onto the queue after the commit (§5.4).
 */
export async function executeTransition(
  db: Kysely<DB>,
  input: ExecuteTransitionInput,
): Promise<TransitionResult> {
  return db.transaction().execute(async (trx): Promise<TransitionResult> => {
    const instance = await trx
      .selectFrom('platform.workflow_instance')
      .selectAll()
      .where('id', '=', input.instanceId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();

    if (!instance) {
      return { ok: false, code: 'NOT_FOUND', detail: `no workflow instance '${input.instanceId}'` };
    }

    if (input.expectedState !== undefined && input.expectedState !== instance.current_state) {
      return {
        ok: false,
        code: 'CONFLICT',
        detail: `expected state '${input.expectedState}' but the instance is in '${instance.current_state}'`,
      };
    }

    const def = requireDefinition(instance.workflow_key, instance.definition_version);
    const transitionDef = def.transitions.find(
      (t) => t.from === instance.current_state && t.action === input.action,
    );
    if (!transitionDef) {
      const known = def.transitions.some((t) => t.action === input.action);
      return known
        ? {
            ok: false,
            code: 'CONFLICT',
            detail: `'${input.action}' is not available from state '${instance.current_state}'`,
          }
        : {
            ok: false,
            code: 'UNKNOWN_ACTION',
            detail: `'${input.action}' is not an action of '${def.key}' v${def.version}`,
          };
    }

    const config = await resolveRefs(trx, configRefsFor(transitionDef), input.now);

    const roles = rolesFor(transitionDef.by, config);
    if (roles === 'system') {
      if (input.actorPersonId !== null) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          detail: `'${input.action}' is a system transition — it is taken by timers and automation, not by a person`,
        };
      }
    } else {
      if (input.actorPersonId === null) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          detail: `'${input.action}' requires a person holding one of: ${roles.join(', ') || '(none — the policy resolved to no role)'}`,
        };
      }
      const grants = await loadGrantsForPerson(trx, input.actorPersonId);
      if (!hasRole(grants, roles, def.module as ModuleKey, input.now)) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          detail: `'${input.action}' requires one of ${roles.join(', ')} in module '${def.module}'`,
        };
      }
    }

    const subject = await requireSubjectLoader(def.key)(trx, instance);
    const evaluation = evaluateTransition(
      def,
      instance.current_state,
      input.action,
      guardRegistry,
      {
        subject,
        input: input.input ?? {},
        config,
        now: input.now,
      },
    );

    if (!evaluation.ok) {
      // Not a business fact: no state, no transition row, no event. The
      // transaction commits having written nothing, which is exactly right —
      // "someone tried and was refused" is an application log line, and an
      // audit trail full of refusals would bury the decisions that did happen.
      return {
        ok: false,
        code: evaluation.reason === 'guard-blocked' ? 'GUARD_BLOCKED' : 'CONFLICT',
        detail: evaluation.detail,
      };
    }

    const updated = await trx
      .updateTable('platform.workflow_instance')
      .set({
        current_state: evaluation.to,
        updated_by: input.actorPersonId,
        ...(evaluation.terminal ? { completed_at: input.now } : {}),
      })
      .where('id', '=', instance.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    const transitionId = newUuidV7();
    // `EffectRef.params` is `Record<string, unknown>` in the definition model and
    // JSON-shaped in the event schema; the definition's own serialisability
    // check (WF-1) is what has already guaranteed the values really are JSON.
    const effects: TransitionedPayload['effects'] = evaluation.effects.map((e) => ({
      name: e.name,
      params: (e.params ?? {}) as TransitionedPayload['effects'][number]['params'],
    }));

    const transition = await trx
      .insertInto('platform.workflow_transition')
      .values({
        id: transitionId,
        instance_id: instance.id,
        from_state: instance.current_state,
        to_state: evaluation.to,
        action: input.action,
        actor_person_id: input.actorPersonId,
        on_behalf_of: input.onBehalfOf ?? null,
        comment: input.comment ?? null,
        guard_results: JSON.stringify(evaluation.guardResults) as never,
        resolved_config: JSON.stringify(config) as never,
        effects: JSON.stringify(effects) as never,
        occurred_at: input.now,
        created_by: input.actorPersonId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // A definition may declare a domain-specific fact instead of the generic
    // type. ADR-0021 requires `stream_type` to be the event type's
    // `<module>.<entity>` prefix, so the override is journalled on the SUBJECT's
    // stream and its prefix must match — enforced here rather than trusted,
    // because a mismatch would corrupt the grammar for every consumer.
    const emits = evaluation.emits;
    if (emits !== undefined) {
      const prefix = emits.split('.').slice(0, 2).join('.');
      if (prefix !== instance.subject_stream_type) {
        throw new Error(
          `workflow '${def.key}' declares emits '${emits}', whose stream prefix '${prefix}' does not match the instance's subject stream '${instance.subject_stream_type}' (ADR-0021)`,
        );
      }
    }

    const payload: TransitionedPayload = {
      transitionId,
      instanceId: instance.id,
      workflowKey: def.key,
      definitionVersion: def.version,
      subjectStreamType: instance.subject_stream_type,
      subjectStreamId: instance.subject_stream_id,
      from: instance.current_state,
      to: evaluation.to,
      action: input.action,
      guardWarnings: evaluation.warnings.map((w) => w.guard),
      effects,
      completed: evaluation.terminal,
    };
    const actor = {
      actorPersonId: input.actorPersonId,
      onBehalfOf: input.onBehalfOf ?? null,
      correlationId: input.correlationId,
    };

    if (emits === undefined) {
      await appendEvent(trx, {
        streamType: 'platform.workflow_instance',
        streamId: instance.id,
        eventType: 'platform.workflow_instance.transitioned',
        payload,
        ...actor,
      });
    } else {
      // The override's name is only known at runtime, so the literal-keyed
      // registry cannot type it. The cast is to the generic type's name
      // specifically, which is exactly the contract an override signs up to:
      // it may rename the fact, not reshape it, and it registers against the
      // shared `workflowTransitionedPayload` schema. `appendEvent` still
      // validates the name and the payload against the registry and throws
      // **before insert** if either is wrong — the check that actually matters.
      await appendEvent(trx, {
        streamType: instance.subject_stream_type,
        streamId: instance.subject_stream_id,
        eventType: emits as 'platform.workflow_instance.transitioned',
        payload,
        ...actor,
      });
    }

    if (evaluation.terminal) {
      // The "a human got there before the chaser" sweep. In the same transaction
      // as the completion, so there is no window in which a finished case still
      // has a live timer pointing at it.
      await cancelScheduledActions(trx, {
        workflowInstanceId: instance.id,
        reason: `workflow completed in state '${evaluation.to}'`,
        actorPersonId: input.actorPersonId,
        correlationId: input.correlationId,
      });
    }

    if (evaluation.schedule.length > 0) {
      const scheduleConfig = await resolveRefs(
        trx,
        scheduleConfigRefs(evaluation.schedule),
        input.now,
      );
      await scheduleRefs(trx, evaluation.schedule, {
        anchor: input.now,
        config: scheduleConfig,
        subject: {
          streamType: instance.subject_stream_type,
          streamId: instance.subject_stream_id,
        },
        workflowInstanceId: instance.id,
        enteringState: evaluation.to,
        createdBy: input.actorPersonId,
        correlationId: input.correlationId,
      });
    }

    return { ok: true, instance: updated, transition, warnings: [...evaluation.warnings] };
  });
}
