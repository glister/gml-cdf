import type { GuardFn, GuardRegistry } from '../types.js';
import { demoGuards } from './demo.js';

/**
 * The guard registry (core plan 07 §5.1, WF-3, ADR-0013).
 *
 * Definitions cite guards by **name**; this map is where the names resolve. That
 * indirection is not ceremony — it is what keeps a definition serialisable, and
 * therefore what lets Phase 2 move definitions into a database table and put an
 * editor on them without touching the runtime. A definition holding an inline
 * function would work today and close that door permanently.
 *
 * Every guard is a pure function of its `GuardContext` (ADR-0009): no database,
 * no clock, no configuration store. A guard that needs data the subject loader
 * did not fetch extends the **loader**, never reaches for the database itself —
 * the one failure mode this design is most likely to invite, and the one review
 * rejects hardest.
 *
 * Later plans add their module's guards the same way: export a named map from
 * `guards/<module>.ts` and spread it below.
 */
export const guardRegistry: GuardRegistry = Object.freeze({
  ...demoGuards,
});

/** Thrown when a definition cites a guard nobody registered. */
export class GuardNotRegisteredError extends Error {
  constructor(readonly guard: string) {
    super(
      `guard '${guard}' is not registered — add it to the map in @repo/domain's workflow/guards/registry.ts`,
    );
    this.name = 'GuardNotRegisteredError';
  }
}

/** Look up a guard, or throw. */
export function requireGuard(name: string): GuardFn {
  const guard = guardRegistry[name];
  if (!guard) throw new GuardNotRegisteredError(name);
  return guard;
}

/** Every registered guard name — used by the definition-conformance test. */
export function guardNames(): string[] {
  return Object.keys(guardRegistry);
}
