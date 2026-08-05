/**
 * `@repo/workflow` — the workflow runtime (core plan 07, ADR-0013).
 *
 * The orchestration home of ADR-0009: apps import it, it never imports apps. It
 * sits above `@repo/db` (data), `@repo/domain` (the pure state machines and
 * guards) and `@repo/config` (decision points), and below `@repo/trpc` and
 * `apps/worker`, which drive it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CONSUMER CONTRACT — read this before building on the runtime (§9.6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Plans 08 (tasks), 09 (approvals) and 10 (notifications), and every HR workflow
 * shape after them, are built on the four seams below. Follow them and the
 * runtime carries the atomicity, audit and idempotency guarantees for you;
 * work around them and you are re-implementing the parts that are hard to get
 * right and easy to get wrong quietly.
 *
 * ── 1. Authoring a definition ──────────────────────────────────────────────
 *
 * `defineWorkflow` in `@repo/domain/workflow/definitions/`, registered in that
 * folder's `index.ts`. A definition is **data**: states, transitions, and
 * *names* referring to guards and effects. It must survive `JSON.stringify`
 * unchanged — that is checked at module load and is the whole Phase 2 door
 * (ADR-0013). No functions, no `Date`s, no class instances.
 *
 *  - Every threshold, cadence, lead time and approver is a `config:` reference
 *    (WF-2). A number in a definition that a business user might one day want to
 *    change is a defect.
 *  - `by` names a **role** or a config reference resolving to one, never a
 *    person; `defineWorkflow` rejects a UUID outright.
 *  - `module` is the grant scope the `by` check runs against, matched exactly
 *    (core plan 04) — pick the module the process belongs to.
 *  - Bump `version` for any shape change and **leave the old version in place**
 *    while instances are pinned to it (WF-4).
 *
 * ── 2. Starting and advancing a case ──────────────────────────────────────
 *
 * `startWorkflow(trx, …)` takes your transaction, so the subject row and the
 * case that governs it commit together. `executeTransition(db, …)` owns its own,
 * because the transaction boundary *is* the semantics: it holds the row lock
 * that serialises concurrent actors, and a blocked guard rolls back to having
 * written nothing at all.
 *
 * Wrap `executeTransition` in a domain procedure when you need richer input
 * validation — but note you **cannot** wrap your way past authorisation: the
 * `by` check runs inside the service, not only at the procedure boundary
 * (ADR-0015, defence in depth).
 *
 * ── 3. Registering a guard ────────────────────────────────────────────────
 *
 * Guards are pure functions in `@repo/domain` (`workflow/guards/`), added to the
 * registry map there. They receive an already-loaded subject, already-resolved
 * config values and an injected `now`. **A guard that needs more data extends
 * the subject loader** — it never takes a database handle. That is the single
 * most likely way this design rots, and review rejects it.
 *
 * Return `warn` rather than `block` wherever the SoW says "warn but allow"
 * (PL-017): the warning reaches the caller and is recorded on the transition
 * row, and the human keeps the decision.
 *
 * ── 4. Registering an effect ──────────────────────────────────────────────
 *
 * `registerEffect(name, handler)`. Effects run **after** the transition commits,
 * on the `effects` queue, via the outbox — so a broker outage delays a
 * consequence but can never split it from its cause. Three rules, all of which
 * fail silently in production if broken:
 *
 *  a. **Idempotent by construction.** Delivery is at-least-once and duplicate
 *     detection has a finite window. Key on
 *     `effectIdempotencyKey(envelope.source)` — `demo.recordOutcome` in
 *     `./demo.ts` is the reference implementation (claim, then act, in one
 *     transaction). Every plan registering an effect owes a re-delivery test.
 *  b. **No sibling ordering.** A transition's effects are separate messages,
 *     delivered concurrently and possibly out of order; one poison effect must
 *     not block the others, which is why they are separate. Sequencing is
 *     expressed as workflow states, never as effect order.
 *  c. **Ids-only params** (ADR-0019). A handler needing a name reads it from the
 *     database; it never travels on the queue.
 *
 * ── What not to build ─────────────────────────────────────────────────────
 *
 * A bespoke timer table, a second approval path, an ad-hoc "status" column
 * alongside `current_state`, or a handler that polls for work — each is a
 * capability this runtime already provides, and each would have to be unwound
 * before Phase 2's engine could read it.
 */

export {
  executeTransition,
  startWorkflow,
  WorkflowAlreadyActiveError,
  type ExecuteTransitionInput,
  type StartWorkflowInput,
  type TransitionFailure,
  type TransitionFailureCode,
  type TransitionResult,
  type TransitionSuccess,
} from './runtime.js';

export {
  cancelScheduledAction,
  cancelScheduledActions,
  dueAtFor,
  rescheduleAction,
  scheduleAction,
  scheduleRefs,
  WORKFLOW_TRANSITION_EFFECT,
  type CancelScheduledActionInput,
  type CancelScheduledActionsInput,
  type RescheduleActionInput,
  type ScheduleActionInput,
  type ScheduledActionRecord,
} from './scheduled-actions.js';

export {
  drainDueActions,
  markScheduledActionExecuted,
  SCHEDULER_BATCH_SIZE,
  type DueAction,
} from './scheduler.js';

export {
  registerSubjectLoader,
  requireSubjectLoader,
  subjectLoaderKeys,
  unregisterSubjectLoaderForTests,
  SubjectLoaderMissingError,
  type SubjectLoader,
} from './subjects.js';

export {
  effectNames,
  hasEffect,
  registerEffect,
  requireEffect,
  unregisterEffectForTests,
  UnknownEffectError,
  type EffectHandler,
  type EffectHandlerContext,
} from './effects/registry.js';

export {
  effectEnvelopeSchema,
  effectIdempotencyKey,
  effectMessageId,
  effectSourceSchema,
  type EffectEnvelope,
  type EffectSource,
} from './effects/types.js';

// Importing these for their side effects is the point: loading the package
// registers the built-in `workflow.transition` handler and the pilot demo
// shape's loader and effect, so a consumer never has to remember to.
export { workflowTransitionEffect } from './effects/workflow-transition.js';
export { demoRecordOutcomeEffect, DEMO_SUBJECT_STREAM_TYPE } from './demo.js';
