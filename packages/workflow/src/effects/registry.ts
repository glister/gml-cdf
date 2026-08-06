import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';
import type { Logger } from '@repo/logging';
import type { EffectEnvelope } from './types.js';

/**
 * The effect-handler registry (core plan 07 §5.4, WF-3/WF-7) — the seam plans
 * 08, 09 and 10 plug into, and the reason the runtime knows nothing about tasks,
 * approvals or notifications.
 *
 * A transition names effects; the runtime never executes them inline. They are
 * fanned onto the `effects` queue by the outbox relay **after** the transition
 * commits, so a Service Bus outage can delay a consequence but can never split
 * it from the state change that caused it (ADR-0010).
 *
 * ## The contract every registered handler must honour
 *
 * 1. **Idempotent by construction.** Delivery is at-least-once and broker
 *    duplicate detection has a finite window, so re-delivery *will* happen and
 *    must be a no-op. Key on `effectIdempotencyKey(envelope.source)`: guard with
 *    `recordConsumptionOnce`, use it as a deterministic child-row id, or make
 *    the write a conditional UPDATE that matches zero rows the second time. A
 *    handler that appends a row unconditionally is a defect — the failure is
 *    silent duplicate work in production, which is why every plan registering an
 *    effect owes a T-W3-style re-delivery test.
 * 2. **No ordering between siblings.** A transition's effects are separate
 *    messages, delivered concurrently and possibly out of order; one poison
 *    effect must not block the others, which is exactly why they are separate.
 *    A handler that assumes a sibling already ran is a defect. Sequencing is
 *    expressed as workflow states, not as effect order.
 * 3. **Throw to retry, and mean it.** Throwing abandons the message for
 *    redelivery up to `max_delivery_count`, then the dead-letter queue. Throw
 *    for transient failures; for a permanent one, record the failure and return,
 *    or the message will be retried ten times before anyone notices.
 * 4. **PII-minimal params** (ADR-0019). Envelope params are ids and primitives.
 *    A handler needing a name reads it from the database under the acting
 *    identity; it never travels on the queue.
 */

export interface EffectHandlerContext {
  db: Kysely<DB>;
  logger: Logger;
}

export type EffectHandler = (envelope: EffectEnvelope, ctx: EffectHandlerContext) => Promise<void>;

const handlers = new Map<string, EffectHandler>();

/**
 * Thrown for an effect name nobody registered. The worker **dead-letters**
 * immediately on this rather than retrying: no amount of redelivery will
 * conjure a handler, and ten futile retries only delay the alert.
 */
export class UnknownEffectError extends Error {
  constructor(readonly effect: string) {
    super(`no handler registered for effect '${effect}'`);
    this.name = 'UnknownEffectError';
  }
}

/**
 * Register an effect handler. Duplicate registration throws — two handlers for
 * one name would make behaviour depend on import order, and the losing one would
 * fail silently.
 */
export function registerEffect(name: string, handler: EffectHandler): void {
  if (handlers.has(name)) {
    throw new Error(`duplicate effect handler registration: '${name}' is already registered`);
  }
  handlers.set(name, handler);
}

/** Look up a handler, or throw {@link UnknownEffectError}. */
export function requireEffect(name: string): EffectHandler {
  const handler = handlers.get(name);
  if (!handler) throw new UnknownEffectError(name);
  return handler;
}

/** Is `name` registered? Used by the definition-conformance test. */
export function hasEffect(name: string): boolean {
  return handlers.has(name);
}

/** Every registered effect name. */
export function effectNames(): string[] {
  return [...handlers.keys()];
}

/** Test-only: drop a registration so a suite can exercise the unknown-effect path. */
export function unregisterEffectForTests(name: string): void {
  handlers.delete(name);
}
