import type { Kysely } from 'kysely';
import type { DB } from '@repo/db';
import type { ApprovalContext, ApprovalWarning } from '../schemas.js';

/**
 * The warning-provider registry (core plan 09 §5.4, PL-017).
 *
 * SoW §5.7 asks for clash and capacity information to be surfaced to requester
 * and approver "as soft warnings". The engine owns the *mechanics* — collect,
 * show, acknowledge, journal the codes — and owns none of the rules: what a
 * leave clash is belongs to the HR plans, and this is the contract they plug
 * into (HL-036/038/039 register here when they land; Phase 1 ships the pilot
 * provider only).
 *
 * ## Three properties, each of them load-bearing
 *
 * **Warnings never block.** There is one severity and it is `'warning'`. PL-017
 * and HL-038 are explicit that this information *informs* and never
 * auto-rejects, and a second severity level would be the first step towards a
 * provider that refuses. A rule that must block is a workflow **guard** (plan
 * 07), evaluated somewhere else entirely, and the distinction is worth keeping
 * sharp: guards are pure and roll a transition back, warnings do I/O and change
 * nothing.
 *
 * **A failing provider degrades; it never fails the request.** These run on
 * `submit`, `previewWarnings` and every `byId`, so a provider with a slow or
 * broken query would otherwise take the whole approval surface down with it.
 * One that throws or overruns its timeout contributes a generic "warnings
 * unavailable" warning — visible, honest, and not a blocked decision.
 *
 * **Providers are named registrations, not data.** Exactly like workflow guards
 * (ADR-0013) and for the same reason: a generic rules engine is something nobody
 * can predict the behaviour of, and §1's anti-scope rules it out.
 *
 * ## Why the handle is a `Kysely<DB>` and not a transaction
 *
 * Providers are **reads**, and the contract says so structurally by not offering
 * them a transaction to write in. They also run concurrently under a timeout,
 * which a shared transaction could not support.
 */

/** What a provider is told about the request it is being asked to warn on. */
export interface ApprovalWarningContext {
  subjectType: string;
  subjectId: string;
  /** `null` for a system-raised request (a timer-fired transition opened it). */
  requestedBy: string | null;
  /** The request's PII-minimal facts (§4.2). */
  context: ApprovalContext;
  /**
   * Who is being shown these warnings. A provider may legitimately say more to
   * one audience than another — HL-036 shows peer names to the requester *by
   * SoW design*, and that judgement belongs to the provider, not to the engine.
   */
  audience: 'requester' | 'approver';
  viewerPersonId: string;
  /** Read-only: providers query, they never write. */
  db: Kysely<DB>;
  /** Business time, passed in — the engine never lets a provider read a clock. */
  now: Date;
}

export type ApprovalWarningProvider = (
  ctx: ApprovalWarningContext,
) => Promise<readonly ApprovalWarning[]>;

interface RegisteredProvider {
  readonly name: string;
  readonly subjectType: string;
  readonly provider: ApprovalWarningProvider;
}

/**
 * How long one provider gets before it is treated as unavailable.
 *
 * A code constant rather than configuration, deliberately: this is a latency
 * budget for a page render, not a business policy, and PL-029's "if it could
 * plausibly change per CDF policy" test does not catch it.
 */
export const WARNING_PROVIDER_TIMEOUT_MS = 2_000;

/** The code a degraded provider contributes — asserted by the §10 warning test. */
export const WARNINGS_UNAVAILABLE_CODE = 'warnings_unavailable';

const providers = new Map<string, RegisteredProvider>();

/** Registry key: one provider name per subject type. */
function keyOf(subjectType: string, name: string): string {
  return `${subjectType}::${name}`;
}

/**
 * Register a warning provider for a subject type.
 *
 * Duplicate registration throws: two providers under one name would make which
 * warnings a decider saw depend on module import order.
 */
export function registerWarningProvider(
  subjectType: string,
  name: string,
  provider: ApprovalWarningProvider,
): void {
  const key = keyOf(subjectType, name);
  if (providers.has(key)) {
    throw new Error(
      `duplicate approval warning provider: '${name}' is already registered for '${subjectType}'`,
    );
  }
  providers.set(key, { name, subjectType, provider });
}

/** Test-only: drop a registration so a suite can re-register a stub. */
export function unregisterWarningProviderForTests(subjectType: string, name: string): void {
  providers.delete(keyOf(subjectType, name));
}

/** Provider names registered for a subject type — for a conformance test. */
export function warningProviderNames(subjectType: string): string[] {
  return [...providers.values()]
    .filter((p) => p.subjectType === subjectType)
    .map((p) => p.name)
    .sort();
}

/** Reject after `ms`, so one slow provider cannot hold a page render open. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Run every provider for a subject type and collect their warnings (PL-017).
 *
 * Concurrent, because they are independent reads and the caller is rendering a
 * page. Per-provider isolation, because the alternative — one provider's bad
 * query making every approval screen in the system fail — is the risk §12.3
 * records against this feature.
 *
 * `logger` is optional so the pure-ish call sites (tests, the effect handler)
 * need not construct one; when present, a degraded provider is logged with its
 * name, because "warnings unavailable" on screen should be traceable to which.
 */
export async function collectWarnings(
  ctx: Omit<ApprovalWarningContext, 'subjectType'> & { subjectType: string },
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void },
): Promise<ApprovalWarning[]> {
  const registered = [...providers.values()].filter((p) => p.subjectType === ctx.subjectType);
  if (registered.length === 0) return [];

  const settled = await Promise.all(
    registered.map(async (entry): Promise<ApprovalWarning[]> => {
      try {
        const warnings = await withTimeout(
          entry.provider(ctx),
          WARNING_PROVIDER_TIMEOUT_MS,
          `approval warning provider '${entry.name}'`,
        );
        // The provider names itself, so a warning cannot be attributed to the
        // wrong one by a copy-pasted string in its return value.
        return warnings.map((warning) => ({ ...warning, provider: entry.name }));
      } catch (error) {
        logger?.warn('approval warning provider failed', {
          provider: entry.name,
          subjectType: ctx.subjectType,
          error: error instanceof Error ? error.message : String(error),
        });
        return [
          {
            provider: entry.name,
            code: WARNINGS_UNAVAILABLE_CODE,
            severity: 'warning',
            message:
              'Some checks could not be run just now, so this may not show everything. You can still proceed.',
          },
        ];
      }
    }),
  );

  return settled.flat();
}
