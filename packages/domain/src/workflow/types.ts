/**
 * The declarative workflow definition model (core plan 07 §5.1, ADR-0013).
 *
 * Everything here is **data**, not code. A definition is a plain object that
 * survives `JSON.stringify` unchanged; guards and effects are *names* resolved
 * in registries, never inline functions. That single constraint is the whole
 * Phase 2 door: moving definitions from code into a database table and putting
 * an editor on them requires no change to the runtime that executes them, so
 * ADR-0013's "Phase 2 is an upgrade, not a rewrite" is structural rather than
 * aspirational. A definition that cannot round-trip through JSON is a defect,
 * and `defineWorkflow` refuses to register one.
 *
 * This module is pure (ADR-0009): no I/O, no clock, no database. The runtime
 * (`@repo/workflow`) resolves config values, loads subjects and reads the clock,
 * then hands the results in.
 */

/**
 * A reference to a decision point in the configuration store (ADR-0016). The
 * runtime resolves it **as-at the transition's `occurred_at`**, so re-reading
 * the journal later reproduces the decision exactly, however many times the
 * value has changed since.
 *
 * Everything a business user might want to change — who approves, how long
 * until something expires, how often to chase — is one of these. A threshold
 * hardcoded in a definition is a review-blocking defect (WF-2).
 */
export type ConfigRef = `config:${string}`;

/** A JSON object — the only value shape a serialisable definition may carry. */
export type JsonObject = Readonly<Record<string, unknown>>;

/**
 * Who may take a transition.
 *
 * Never an individual (§8): a policy names a **role**, or a `config:` reference
 * resolving to one, so changing who approves is a configuration change and role
 * membership resolves at execution time (PL-021 — a leaver stops approving the
 * moment their grant ends, with no definition edit). `{ system: true }` marks a
 * transition only the runtime itself may take: timers, automation, sweeps.
 */
export type TransitionActorPolicy =
  { readonly role: string } | { readonly configRef: ConfigRef } | { readonly system: true };

/** Units a timer lead time can be expressed in. Day-granular is the common case. */
export type DelayUnit = 'minutes' | 'hours' | 'days';

/** A fixed lead time — for structural delays that are not business decisions. */
export interface FixedDelay {
  readonly unit: DelayUnit;
  readonly amount: number;
}

/**
 * A configurable lead time (the usual case): the amount comes from the config
 * store as-at the scheduling instant, so "chase the fit note on day 7" becomes
 * "on day 10" without a release (SA AC-2, PL-020).
 */
export interface ConfiguredDelay {
  readonly unit: DelayUnit;
  readonly configRef: ConfigRef;
}

export type DelaySpec = FixedDelay | ConfiguredDelay;

/** Narrow a {@link DelaySpec} to the config-resolved form. */
export function isConfiguredDelay(delay: DelaySpec): delay is ConfiguredDelay {
  return 'configRef' in delay;
}

/**
 * A timer the runtime creates on entering a state — one `platform.scheduled_action`
 * row, due `delay` after the entering instant.
 *
 * `actionType` is an effect-registry name, so a timer is just a deferred effect:
 * `'workflow.transition'` (fire a named action back at this instance — the
 * built-in), `'notification.reminder'` (plan 10), and so on.
 */
export interface ScheduleRef {
  readonly actionType: string;
  /** Ids and parameters only — the row is journalled and relayed (ADR-0019). */
  readonly params?: JsonObject;
  readonly delay: DelaySpec;
}

/**
 * An effect to fan onto the `effects` queue when a transition commits. Effects
 * are executed **after** the transaction, by the worker, via the outbox — so a
 * Service Bus outage can never split a state change from its consequences.
 */
export interface EffectRef {
  /** Registry name, e.g. `'demo.recordOutcome'`, `'tasks.raiseList'` (plan 08). */
  readonly name: string;
  /** Ids-only parameters (ADR-0019). */
  readonly params?: JsonObject;
}

export interface WorkflowTransitionDef<S extends string = string> {
  readonly from: S;
  readonly to: S;
  /** The named action. Unique per `(from, action)` — that pair is the key. */
  readonly action: string;
  readonly by: TransitionActorPolicy;
  /** Names in the `@repo/domain` guard registry, evaluated in order. */
  readonly guards?: readonly string[];
  /**
   * Decision points this transition's guards read. Declared explicitly rather
   * than inferred so `workflow_transition.resolved_config` snapshots exactly
   * what the decision rested on — no more (noise) and no less (an unauditable
   * decision). The `by` policy's own ref and every `schedule` ref are resolved
   * and snapshotted too, without needing to be repeated here.
   */
  readonly config?: readonly ConfigRef[];
  readonly effects?: readonly EffectRef[];
  /**
   * Emit a domain-specific past-tense fact instead of the generic
   * `platform.workflow_instance.transitioned` — one event per transition, never
   * two. Its `<module>.<entity>` prefix **must** equal the instance's
   * `subject_stream_type` (ADR-0021), which the runtime enforces at emit time:
   * that is what keeps `stream_type` and `event_type` in agreement.
   */
  readonly emits?: string;
  /** Timers created on entering `to`. */
  readonly schedule?: readonly ScheduleRef[];
}

export interface WorkflowDefinition<S extends string = string> {
  /** e.g. `'platform.demo.request'`, later `'hr.leave.approval'`. */
  readonly key: string;
  /** Integer ≥ 1. Bump on any shape change; running instances stay pinned. */
  readonly version: number;
  readonly states: readonly S[];
  readonly initial: S;
  /** Entering one sets `completed_at` and cancels the instance's pending timers. */
  readonly terminal: readonly S[];
  readonly transitions: readonly WorkflowTransitionDef<S>[];
  /** Timers created by `startWorkflow` on entering `initial`. */
  readonly initialSchedule?: readonly ScheduleRef[];
}

/** A guard's verdict on a proposed transition. */
export type GuardOutcome =
  | { readonly outcome: 'pass' }
  /** Soft warning — the transition proceeds and the warning is recorded (PL-017). */
  | { readonly outcome: 'warn'; readonly detail: string }
  /** Hard block — the transition is rejected and **nothing is written**. */
  | { readonly outcome: 'block'; readonly detail: string };

/**
 * Everything a guard is allowed to know. Note what is absent: no database
 * handle, no config *store* (only already-resolved values), and no clock —
 * `now` is passed in (ADR-0009), which is why every boundary case is testable
 * without faking time.
 */
export interface GuardContext {
  /** Loaded by the runtime's registered subject loader — never fetched here. */
  readonly subject: unknown;
  /** Caller-supplied action input (comment, amounts, choices). */
  readonly input: Readonly<Record<string, unknown>>;
  /** Resolved `config:` values, keyed by qualified name (no `config:` prefix). */
  readonly config: Readonly<Record<string, unknown>>;
  readonly now: Date;
}

export type GuardFn = (ctx: GuardContext) => GuardOutcome;

/** Name → guard. Assembled in `guards/registry.ts`; definitions cite names. */
export type GuardRegistry = Readonly<Record<string, GuardFn>>;

/** One guard's recorded verdict, as stored in `workflow_transition.guard_results`. */
export interface GuardResult {
  readonly guard: string;
  readonly outcome: 'pass' | 'warn';
  readonly detail?: string;
}

/** A soft warning surfaced to the caller and recorded on the transition row. */
export interface GuardWarning {
  readonly guard: string;
  readonly detail: string;
}
