/**
 * Dependency-graph evaluation (core plan 08 §9.2, PL-014) — pure.
 *
 * A task waits on two kinds of thing: **other tasks** in the same case reaching
 * a terminal state, and **named gates** the case opens (`verification`, a
 * licence check). Both are the same idea — an edge that blocks until it is
 * satisfied — which is what lets one mechanism express onboarding's "the
 * verification gate blocks role-confirmation and vehicle allocation while the
 * IT and PPE lanes run in parallel" (ON-033) with no onboarding vocabulary
 * anywhere in the engine.
 *
 * This module answers three questions and nothing else: is the graph legal
 * (acyclic), what status does a task start in, and which tasks did *that*
 * satisfaction just unblock. Stamping rows and appending events is the service's
 * work (ADR-0009); everything here is a function of its arguments.
 */

/** What an edge waits on. Gate keys are case-scoped; task ids are global. */
export type BlockerRef = { kind: 'task'; taskId: string } | { kind: 'gate'; gateKey: string };

/** One dependency row, reduced to what the graph reasoning needs. */
export interface DependencyEdge {
  /** The task held up by this edge. */
  taskId: string;
  blocker: BlockerRef;
  satisfied: boolean;
}

/** A proposed graph contains a cycle: A waits on B waits on A. */
export class CycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`task dependencies form a cycle (${cycle.join(' → ')}) — nothing in it could ever start`);
    this.name = 'CycleError';
  }
}

/** Two blocker references pointing at the same thing. */
export function sameBlocker(a: BlockerRef, b: BlockerRef): boolean {
  if (a.kind === 'task' && b.kind === 'task') return a.taskId === b.taskId;
  if (a.kind === 'gate' && b.kind === 'gate') return a.gateKey === b.gateKey;
  return false;
}

/**
 * Reject a task→task dependency graph that cannot ever complete.
 *
 * Kahn's algorithm: repeatedly remove nodes with no outstanding prerequisites.
 * Whatever survives is in — or downstream of — a cycle, and the reported path is
 * walked back through it so the message names the loop rather than the wreckage.
 *
 * **Gate edges are not part of this check**, deliberately: a gate is opened from
 * outside the task graph, so it can never participate in a cycle of tasks. Only
 * task→task edges can.
 *
 * Callers pass the *combined* set — the list being raised plus the edges already
 * in the database for the same case — because a new task can close a loop that
 * neither half contains on its own.
 */
export function assertAcyclic(edges: readonly { taskRef: string; dependsOnRef: string }[]): void {
  const outstanding = new Map<string, Set<string>>(); // task → prerequisites
  const dependents = new Map<string, Set<string>>(); // prerequisite → tasks waiting

  const ensure = (map: Map<string, Set<string>>, key: string): Set<string> => {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    return set;
  };

  for (const { taskRef, dependsOnRef } of edges) {
    if (taskRef === dependsOnRef) throw new CycleError([taskRef, taskRef]);
    ensure(outstanding, taskRef).add(dependsOnRef);
    ensure(outstanding, dependsOnRef);
    ensure(dependents, dependsOnRef).add(taskRef);
  }

  const ready = [...outstanding].filter(([, deps]) => deps.size === 0).map(([task]) => task);
  const settled = new Set<string>();

  while (ready.length > 0) {
    const task = ready.pop()!;
    settled.add(task);
    for (const dependent of dependents.get(task) ?? []) {
      const deps = outstanding.get(dependent)!;
      deps.delete(task);
      if (deps.size === 0) ready.push(dependent);
    }
  }

  const stuck = [...outstanding.keys()].filter((task) => !settled.has(task));
  if (stuck.length === 0) return;

  throw new CycleError(findCycle(stuck, outstanding));
}

/**
 * Walk the unsettled subgraph until a node repeats, then return the loop itself.
 * Everything in `stuck` is a cycle member or downstream of one, so following any
 * outstanding prerequisite from any of them reaches a cycle in finite steps.
 */
function findCycle(stuck: readonly string[], outstanding: Map<string, Set<string>>): string[] {
  const stuckSet = new Set(stuck);
  const path: string[] = [];
  const seen = new Map<string, number>();
  let node = stuck[0]!;

  for (;;) {
    const previous = seen.get(node);
    if (previous !== undefined) return [...path.slice(previous), node];
    seen.set(node, path.length);
    path.push(node);
    const next = [...(outstanding.get(node) ?? [])].find((dep) => stuckSet.has(dep));
    if (next === undefined) return path; // defensive: cannot happen for a stuck node
    node = next;
  }
}

/**
 * A task's status at raise time: `blocked` if anything is holding it, else
 * `open`. There is no third answer, and no boolean flag — this is the whole of
 * §4.3's initial-state rule (SoW §6 principle 7).
 */
export function initialStatus(unsatisfiedDependencyCount: number): 'blocked' | 'open' {
  return unsatisfiedDependencyCount > 0 ? 'blocked' : 'open';
}

/**
 * Which tasks does satisfying `justSatisfied` unblock?
 *
 * `edges` must be every edge of every task touched by this satisfaction — the
 * matching edges *and* their tasks' other edges — or a task with two blockers
 * would look unblocked when only one cleared. Returns only tasks that actually
 * waited on `justSatisfied`: a task that was already unblocked is not unblocked
 * again, and re-announcing it would put a second `platform.task.unblocked` event
 * in the trail for a fact that happened once.
 */
export function evaluateUnlocks(
  edges: readonly DependencyEdge[],
  justSatisfied: BlockerRef,
): string[] {
  const affected = new Set<string>();
  const stillBlocked = new Set<string>();

  for (const edge of edges) {
    const matches = sameBlocker(edge.blocker, justSatisfied);
    if (matches) affected.add(edge.taskId);
    if (!matches && !edge.satisfied) stillBlocked.add(edge.taskId);
  }

  return [...affected].filter((taskId) => !stillBlocked.has(taskId));
}
