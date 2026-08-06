/**
 * The declarative workflow model (core plan 07 §5.1, ADR-0013) — definitions,
 * pure transition evaluation, and the guard registry. Re-exported from the
 * package root.
 *
 * What is **not** here is as deliberate as what is: no transition execution, no
 * database, no clock, no configuration lookups. Those are orchestration and live
 * in `@repo/workflow` (ADR-0009). This half is data plus pure functions, which
 * is why the whole state-machine layer is testable with no database and no
 * mocks — and why Phase 2 can move the definitions into a table without the
 * logic that reasons about them changing at all.
 */
export {
  isConfiguredDelay,
  type ConfigRef,
  type ConfiguredDelay,
  type DelaySpec,
  type DelayUnit,
  type EffectRef,
  type FixedDelay,
  type GuardContext,
  type GuardFn,
  type GuardOutcome,
  type GuardRegistry,
  type GuardResult,
  type GuardWarning,
  type JsonObject,
  type ScheduleRef,
  type TransitionActorPolicy,
  type WorkflowDefinition,
  type WorkflowTransitionDef,
} from './types.js';

export { defineWorkflow, WorkflowDefinitionError } from './define.js';

export {
  configRefsFor,
  evaluateTransition,
  scheduleConfigRefs,
  WorkflowGuardMissingError,
  type TransitionAllowed,
  type TransitionEvaluation,
  type TransitionRejected,
} from './evaluate.js';

export {
  guardNames,
  guardRegistry,
  requireGuard,
  GuardNotRegisteredError,
} from './guards/registry.js';

export {
  allDefinitions,
  definitionId,
  demoRequestV1,
  latestDefinition,
  registerDefinitionForTests,
  requireDefinition,
  unregisterDefinitionForTests,
  WorkflowNotRegisteredError,
} from './definitions/index.js';

export {
  DEMO_APPROVER_ROLE_KEY,
  DEMO_APPROVER_ROLE_REF,
  DEMO_EXPIRY_HOURS_KEY,
  DEMO_EXPIRY_HOURS_REF,
} from './demo-config-keys.js';

export type { DemoRequestSubject } from './guards/demo.js';
