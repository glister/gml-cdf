import type {
  EffectRef,
  GuardContext,
  GuardRegistry,
  GuardResult,
  GuardWarning,
  ScheduleRef,
  WorkflowDefinition,
  WorkflowTransitionDef,
} from './types.js';

/**
 * `evaluateTransition` — the pure decision at the heart of the runtime (core
 * plan 07 §5.1, WF-3).
 *
 * Given a definition, where the instance currently is, the action proposed and
 * an already-populated context, it answers: may this happen, where does it land,
 * and what follows. It performs **no I/O and reads no clock** — the runtime
 * loads the subject, resolves the config and stamps `now` before calling in
 * (ADR-0009), which is why every guard boundary is unit-testable with no
 * database and no fake timers.
 *
 * Authorisation is deliberately *not* evaluated here. Resolving a `by` policy
 * needs the actor's live role grants, which is a database read; the runtime does
 * that in `executeTransition` before calling this. Keeping it out is what lets
 * this function stay pure.
 */

/** A guard named by a definition but absent from the registry — a wiring bug. */
export class WorkflowGuardMissingError extends Error {
  constructor(
    readonly workflowKey: string,
    readonly guard: string,
  ) {
    super(
      `workflow '${workflowKey}' names guard '${guard}', which is not in the guard registry — register it in @repo/domain before the definition can execute`,
    );
    this.name = 'WorkflowGuardMissingError';
  }
}

export interface TransitionAllowed<S extends string = string> {
  readonly ok: true;
  readonly to: S;
  /** Entering `to` completes the instance and cancels its pending timers. */
  readonly terminal: boolean;
  readonly transition: WorkflowTransitionDef<S>;
  /** Every guard's verdict, for `workflow_transition.guard_results`. */
  readonly guardResults: readonly GuardResult[];
  /** The subset that warned — returned to the caller and surfaced in the UI. */
  readonly warnings: readonly GuardWarning[];
  readonly effects: readonly EffectRef[];
  /** Domain-specific event type to emit instead of the generic one, if declared. */
  readonly emits?: string;
  readonly schedule: readonly ScheduleRef[];
}

export interface TransitionRejected {
  readonly ok: false;
  readonly reason: 'unknown-action' | 'wrong-state' | 'guard-blocked';
  readonly detail: string;
  /** For `wrong-state`: the states from which this action *is* available. */
  readonly availableFrom?: readonly string[];
  /** For `guard-blocked`: every guard that blocked, in evaluation order. */
  readonly blockedBy?: readonly GuardWarning[];
}

export type TransitionEvaluation<S extends string = string> =
  TransitionAllowed<S> | TransitionRejected;

/**
 * Evaluate `action` against `currentState`.
 *
 * Rejection distinguishes two shapes deliberately, because they mean different
 * things to a caller: `unknown-action` is a client error (a bad request, or a
 * definition version mismatch), while `wrong-state` is a **race** — the case
 * moved under you — and is what a stale timer or a second approver sees. The
 * runtime maps the latter to `CONFLICT`, and the built-in timer handler treats
 * it as a recorded no-op rather than a failure (§5.4).
 *
 * All guards are evaluated even after one blocks, so the error explains every
 * reason the transition failed rather than just the first.
 */
export function evaluateTransition<S extends string>(
  def: WorkflowDefinition<S>,
  currentState: S,
  action: string,
  guards: GuardRegistry,
  ctx: GuardContext,
): TransitionEvaluation<S> {
  const byAction = def.transitions.filter((t) => t.action === action);
  if (byAction.length === 0) {
    return {
      ok: false,
      reason: 'unknown-action',
      detail: `'${action}' is not an action of workflow '${def.key}' v${def.version}`,
    };
  }

  const transition = byAction.find((t) => t.from === currentState);
  if (!transition) {
    const availableFrom = byAction.map((t) => t.from);
    return {
      ok: false,
      reason: 'wrong-state',
      detail: `'${action}' is not available from state '${currentState}' (available from: ${availableFrom.join(', ')})`,
      availableFrom,
    };
  }

  const guardResults: GuardResult[] = [];
  const warnings: GuardWarning[] = [];
  const blockedBy: GuardWarning[] = [];

  for (const name of transition.guards ?? []) {
    const guard = guards[name];
    if (!guard) throw new WorkflowGuardMissingError(def.key, name);

    const outcome = guard(ctx);
    if (outcome.outcome === 'block') {
      blockedBy.push({ guard: name, detail: outcome.detail });
      continue;
    }
    if (outcome.outcome === 'warn') {
      warnings.push({ guard: name, detail: outcome.detail });
      guardResults.push({ guard: name, outcome: 'warn', detail: outcome.detail });
      continue;
    }
    guardResults.push({ guard: name, outcome: 'pass' });
  }

  if (blockedBy.length > 0) {
    return {
      ok: false,
      reason: 'guard-blocked',
      detail: blockedBy.map((b) => `${b.guard}: ${b.detail}`).join('; '),
      blockedBy,
    };
  }

  return {
    ok: true,
    to: transition.to,
    terminal: def.terminal.includes(transition.to),
    transition,
    guardResults,
    warnings,
    effects: transition.effects ?? [],
    ...(transition.emits === undefined ? {} : { emits: transition.emits }),
    schedule: transition.schedule ?? [],
  };
}

/**
 * Every `config:` reference a transition rests on: its `by` policy, the decision
 * points its guards declared, and the lead times of any timers it creates.
 *
 * The runtime resolves exactly this set as-at `occurred_at` and snapshots it
 * onto `workflow_transition.resolved_config`, which is what makes a past
 * decision reproducible after the configuration has moved on (ADR-0016).
 */
export function configRefsFor(transition: WorkflowTransitionDef): string[] {
  const refs = new Set<string>();
  if ('configRef' in transition.by) refs.add(transition.by.configRef);
  for (const ref of transition.config ?? []) refs.add(ref);
  for (const ref of scheduleConfigRefs(transition.schedule ?? [])) refs.add(ref);
  return [...refs];
}

/** The `config:` references a set of timer specs needs to compute `due_at`. */
export function scheduleConfigRefs(schedule: readonly ScheduleRef[]): string[] {
  const refs = new Set<string>();
  for (const ref of schedule) {
    if ('configRef' in ref.delay) refs.add(ref.delay.configRef);
  }
  return [...refs];
}
