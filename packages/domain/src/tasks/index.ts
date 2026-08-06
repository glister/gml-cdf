/**
 * The task engine's pure half (core plan 08 §9.2, ADR-0009): due-date
 * resolution, dependency-graph reasoning and the status machine.
 *
 * What is **not** here is the point: no inserts, no journal appends, no unlock
 * orchestration. Those need a transaction and belong to the engine services in
 * `@repo/trpc/lib/tasks.ts`. Splitting it this way is what makes the awkward
 * parts — DST boundaries, cycle detection, "which of these five tasks did that
 * completion actually unblock?" — testable with no database and no mocks.
 */
export {
  dueDateChanged,
  resolveDueDate,
  DueDateSpecError,
  UnknownAnchorError,
  type AnchorMap,
  type DueDateOptions,
  type DueSpec,
} from './due-date.js';

export {
  assertAcyclic,
  evaluateUnlocks,
  initialStatus,
  sameBlocker,
  CycleError,
  type BlockerRef,
  type DependencyEdge,
} from './dependency-graph.js';

export {
  canTransitionTask,
  isTerminalTaskStatus,
  nextTaskStatus,
  satisfiesDependents,
  TaskTransitionError,
  TERMINAL_TASK_STATUSES,
  type TaskAction,
  type TaskStatus,
} from './status.js';
