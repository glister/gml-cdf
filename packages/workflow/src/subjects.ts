import type { Kysely, Transaction } from 'kysely';
import type { DB, WorkflowInstanceRecord } from '@repo/db';

/**
 * Subject loaders (core plan 07 §9.3) — the runtime's **only** I/O seam into a
 * workflow's subject data.
 *
 * A guard is pure and receives its subject in `ctx.subject` (ADR-0009). Someone
 * has to fetch it, and that someone is a loader registered here, per workflow
 * key. The indirection buys the thing the whole design rests on: a guard that
 * needs data the loader did not fetch **extends the loader** — it never reaches
 * for a database handle. That is the most likely way this architecture would rot
 * (§12.3 names it as a risk), and it is the one review rejects hardest.
 *
 * A loader runs inside the transition's transaction, so what a guard sees is
 * consistent with the row lock the runtime already holds.
 *
 * Cross-module note (ADR-0008): a loader for an `hr.*` workflow reads `hr.*`
 * tables and is registered by the HR module's own code — the runtime never
 * learns another module's schema, it just calls the function it was handed.
 */

export type SubjectLoader = (
  trx: Transaction<DB>,
  instance: WorkflowInstanceRecord,
) => Promise<unknown>;

const loaders = new Map<string, SubjectLoader>();

/** Thrown when a workflow executes with no loader registered for its key. */
export class SubjectLoaderMissingError extends Error {
  constructor(readonly workflowKey: string) {
    super(
      `no subject loader registered for workflow '${workflowKey}' — register one with registerSubjectLoader() where the workflow's definition is wired up`,
    );
    this.name = 'SubjectLoaderMissingError';
  }
}

/**
 * Register the loader for a workflow key. Registration is per **key**, not per
 * version: a definition's states and rules are versioned, but what its subject
 * *is* does not change across versions of the same process.
 *
 * Re-registering the same key throws — two loaders would make what a guard sees
 * depend on import order.
 */
export function registerSubjectLoader(workflowKey: string, loader: SubjectLoader): void {
  if (loaders.has(workflowKey)) {
    throw new Error(`duplicate subject loader for workflow '${workflowKey}'`);
  }
  loaders.set(workflowKey, loader);
}

/** Look up a loader, or throw {@link SubjectLoaderMissingError}. */
export function requireSubjectLoader(workflowKey: string): SubjectLoader {
  const loader = loaders.get(workflowKey);
  if (!loader) throw new SubjectLoaderMissingError(workflowKey);
  return loader;
}

/** Every workflow key that has a loader — used by the conformance test. */
export function subjectLoaderKeys(): string[] {
  return [...loaders.keys()];
}

/** Test-only: drop a registration so a suite can exercise the missing-loader path. */
export function unregisterSubjectLoaderForTests(workflowKey: string): void {
  loaders.delete(workflowKey);
}

/**
 * A loader is handed a `Transaction`, but nothing stops a caller passing the
 * root instance where only reads happen; this alias documents the intent at the
 * few call sites that do.
 */
export type ReadableDb = Kysely<DB> | Transaction<DB>;
