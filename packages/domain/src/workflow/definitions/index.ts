import type { WorkflowDefinition } from '../types.js';
import { demoRequestV1 } from './demo-request.js';

/**
 * The workflow definition registry (core plan 07 §5.1, WF-1/WF-4).
 *
 * Definitions are **code, not rows**, in Phase 1 — registered here and looked up
 * by `(key, version)`. Their serialisability (proven by `define.test.ts`) is
 * exactly what lets Phase 2 move this map into a database table without the
 * runtime noticing.
 *
 * **Old versions are retained** while any non-completed instance is pinned to
 * them (WF-4). Deleting v1 the day v2 ships would silently break every case
 * mid-flight — the pinning promise is only as good as the code still being here.
 * Retiring a version is gated on "no active instances on version N", which
 * `platform.workflow.listInstances` can answer (§12.2 Q3).
 */

/** `${key}@${version}` — the registry's compound key. */
export function definitionId(key: string, version: number): string {
  return `${key}@${version}`;
}

const definitions = new Map<string, WorkflowDefinition>(
  [demoRequestV1].map((def) => [definitionId(def.key, def.version), def as WorkflowDefinition]),
);

/** Thrown when an instance is pinned to a version no longer in the registry. */
export class WorkflowNotRegisteredError extends Error {
  constructor(
    readonly workflowKey: string,
    readonly version?: number,
  ) {
    super(
      version === undefined
        ? `no workflow definition registered for key '${workflowKey}'`
        : `workflow '${workflowKey}' has no registered version ${version} — a running instance is pinned to it, so the definition must not be removed (WF-4)`,
    );
    this.name = 'WorkflowNotRegisteredError';
  }
}

/** Every registered definition. */
export function allDefinitions(): WorkflowDefinition[] {
  return [...definitions.values()];
}

/** The highest registered version of `key`, which `startWorkflow` pins to. */
export function latestDefinition(key: string): WorkflowDefinition {
  const versions = allDefinitions().filter((d) => d.key === key);
  if (versions.length === 0) throw new WorkflowNotRegisteredError(key);
  return versions.reduce((best, d) => (d.version > best.version ? d : best));
}

/** The exact version an instance is pinned to. */
export function requireDefinition(key: string, version: number): WorkflowDefinition {
  const def = definitions.get(definitionId(key, version));
  if (!def) throw new WorkflowNotRegisteredError(key, version);
  return def;
}

/** Test-only: register an extra definition (e.g. a v2 for the pinning test). */
export function registerDefinitionForTests(def: WorkflowDefinition): void {
  definitions.set(definitionId(def.key, def.version), def);
}

/** Test-only: undo {@link registerDefinitionForTests}. */
export function unregisterDefinitionForTests(key: string, version: number): void {
  definitions.delete(definitionId(key, version));
}

export { demoRequestV1 };
