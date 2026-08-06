import { assertAcyclic } from './dependency-graph.js';
import { ROLE_KEYS, type RoleKey } from '../authz/roles.js';

/**
 * Task-list definitions (core plan 08 §9.6) — the "what to raise" half of
 * `tasks.raiseList`, as **data**.
 *
 * A workflow transition names an effect and its parameters, and those parameters
 * ride the `effects` queue, so they must be small and ids-only (ADR-0019). A
 * whole task list is neither. The definition therefore travels as a **key**, and
 * the list itself lives here in code — registered, validated at module load, and
 * serialisable, exactly like a workflow definition (ADR-0013).
 *
 * Two consequences are the point:
 *
 *  - **Roles are named by key, never by id.** A definition cannot contain a
 *    `platform.role` UUID — those are database rows, and a definition that
 *    embedded one would break on a fresh environment and could not be moved into
 *    a table in Phase 2. The effect handler resolves `it` → the role's id at
 *    raise time, which is also the moment membership resolves (PL-014).
 *  - **Lanes and gate keys stay opaque strings.** They are vocabulary belonging
 *    to the raising process, not to the engine (§4.4).
 *
 * Unlike workflow definitions, task lists are **not version-pinned**: a list is
 * read once, at the instant it is raised, and never consulted again — the tasks
 * it produced are the record. `version` exists to stamp `sourceRef`, so a task
 * can be traced back to the revision of the list that produced it.
 */

/** A due specification as a definition writes it — dates as ISO strings. */
export type TaskListDueSpec =
  | { mode: 'none' }
  | { mode: 'absolute'; dueAt: string }
  | { mode: 'anchor_relative'; anchorName: string; offsetDays: number };

export interface TaskListItemSpec {
  /** List-local identity; dependencies name siblings by it, and it stamps `sourceRef`. */
  ref: string;
  title: string;
  description?: string;
  /** Dashboard grouping — `it`, `transport`, `hr` (§4.1). */
  lane?: string;
  /** A role **key** (`it`), resolved to its id when the list is raised. */
  assigneeRoleKey: RoleKey;
  due?: TaskListDueSpec;
  /** Refs of siblings that must finish first. */
  dependsOn?: readonly string[];
  /** Named gates on the case that must open first. */
  gates?: readonly string[];
}

export interface TaskListDefinition {
  /** `platform.pilot.checklist` — dotted, lowercase, like a workflow key. */
  key: string;
  /** Bumped when the list changes; stamped onto each task's `sourceRef`. */
  version: number;
  tasks: readonly TaskListItemSpec[];
}

export class TaskListDefinitionError extends Error {
  constructor(key: string, detail: string) {
    super(`invalid task list '${key}': ${detail}`);
    this.name = 'TaskListDefinitionError';
  }
}

const LIST_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const REF_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

const registry = new Map<string, TaskListDefinition>();

/**
 * Validate and register a task list. Everything a raise could reject at runtime
 * — an unknown role key, a dependency on a task that is not in the list, a cycle
 * — is rejected here instead, at module load, so a broken list stops a
 * deployment rather than a case.
 */
export function defineTaskList(def: TaskListDefinition): TaskListDefinition {
  const fail = (detail: string): never => {
    throw new TaskListDefinitionError(def.key, detail);
  };

  if (!LIST_KEY_PATTERN.test(def.key)) {
    fail("key must be a lowercase, namespaced, dotted name (e.g. 'platform.pilot.checklist')");
  }
  if (!Number.isInteger(def.version) || def.version < 1) fail('version must be a positive integer');
  if (def.tasks.length === 0) fail('a list with no tasks raises nothing');

  const refs = new Set<string>();
  for (const task of def.tasks) {
    if (!REF_PATTERN.test(task.ref)) fail(`ref '${task.ref}' is not a slug`);
    if (refs.has(task.ref)) fail(`duplicate ref '${task.ref}'`);
    refs.add(task.ref);
    if (task.title.trim().length === 0) fail(`task '${task.ref}' has an empty title`);
    if (!(ROLE_KEYS as readonly string[]).includes(task.assigneeRoleKey)) {
      fail(`task '${task.ref}' names an unknown role '${task.assigneeRoleKey}'`);
    }
    if (task.due?.mode === 'anchor_relative' && !Number.isInteger(task.due.offsetDays)) {
      fail(`task '${task.ref}' has a non-integer anchor offset`);
    }
  }

  const edges: { taskRef: string; dependsOnRef: string }[] = [];
  for (const task of def.tasks) {
    for (const dependsOnRef of task.dependsOn ?? []) {
      if (!refs.has(dependsOnRef)) {
        fail(`task '${task.ref}' depends on '${dependsOnRef}', which is not in the list`);
      }
      edges.push({ taskRef: task.ref, dependsOnRef });
    }
  }
  // A cycle inside a list is an authoring mistake, and it would otherwise only
  // surface as a rejected raise on a live case.
  assertAcyclic(edges);

  if (registry.has(def.key)) fail('already registered — two lists under one key');
  const frozen = Object.freeze(def);
  registry.set(def.key, frozen);
  return frozen;
}

/** Thrown when an effect names a list nobody registered. */
export class TaskListNotRegisteredError extends Error {
  constructor(readonly key: string) {
    super(`no task list registered under '${key}'`);
    this.name = 'TaskListNotRegisteredError';
  }
}

export function requireTaskList(key: string): TaskListDefinition {
  const def = registry.get(key);
  if (!def) throw new TaskListNotRegisteredError(key);
  return def;
}

export function taskListKeys(): string[] {
  return [...registry.keys()];
}

/** `platform.pilot.checklist@1#it_setup` — provenance stamped on every task. */
export function taskSourceRef(def: TaskListDefinition, ref: string): string {
  return `${def.key}@${def.version}#${ref}`;
}

/** Test-only: drop a registration so a suite can exercise the load-time rules. */
export function unregisterTaskListForTests(key: string): void {
  registry.delete(key);
}
