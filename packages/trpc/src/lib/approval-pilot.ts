import { PILOT_SIGNOFF_SUBJECT } from '@repo/domain';
import { registerSubjectLoader } from '@repo/workflow';
import { registerWarningProvider } from './approval-warnings.js';

/**
 * The approval engine's pilot slice (core plan 09 §9.8) — the demonstration
 * that PL-016…018 work, before any HR module exists to demonstrate them on.
 *
 * Everything here retires with the pilot, exactly as plan 07's
 * `platform.demo.request` and plan 08's `platform.pilot_case` will. It carries
 * **no HR content**: leave clashes, team capacity and training spend are the HR
 * plans' vocabulary, and this file deliberately knows none of it.
 *
 * The slice's other halves live where they belong rather than here — the subject
 * type's policy and threshold are registered in `@repo/config`'s key file, and
 * the workflow shape in `@repo/domain`'s definition registry.
 */

/** The demo warning provider's name and its one code (asserted by the tests). */
export const PILOT_WARNING_PROVIDER = 'pilot_spend';
export const PILOT_LARGE_AMOUNT_CODE = 'large_amount';

/** Above this, the provider warns. Below the config threshold, nothing is asked at all. */
const LARGE_AMOUNT = 2000;

/**
 * A soft warning on a large amount (PL-017, AC-D6).
 *
 * The smallest thing that demonstrates the contract honestly: it reads only the
 * request's PII-minimal `context`, it never blocks, and its `message` is prose
 * that is rendered live and **never persisted** — only `{ provider, code }` is
 * acknowledged and stored, which is what keeps free text out of an append-only
 * table (ADR-0019).
 *
 * A real provider — HL-038's team max-off-at-once, HL-039's manager/deputy
 * overlap — queries for its answer. This one does not need to, and pretending
 * otherwise would make the pilot slower without making it more convincing.
 */
registerWarningProvider(PILOT_SIGNOFF_SUBJECT, PILOT_WARNING_PROVIDER, (ctx) => {
  const amount = ctx.context.amount;
  if (typeof amount !== 'number' || amount <= LARGE_AMOUNT) return Promise.resolve([]);

  return Promise.resolve([
    {
      provider: PILOT_WARNING_PROVIDER,
      code: PILOT_LARGE_AMOUNT_CODE,
      severity: 'warning' as const,
      message: `This is a large amount (£${amount.toLocaleString('en-GB')}). You can still approve it.`,
      // Detail is rendered, never stored — the acknowledgement carries the code.
      detail: { amount, threshold: LARGE_AMOUNT },
    },
  ]);
});

/**
 * The pilot shape's subject loader.
 *
 * Its subject is synthetic and has no table behind it — deliberately, so the
 * slice proves the engine with no HR content — so there is nothing to fetch and
 * no guard to feed. A real workflow's loader reads its subject's row; the
 * contract is the same either way, and a guard never sees a database handle
 * (plan 07 §9.3).
 */
registerSubjectLoader('platform.pilot.signoff', () => Promise.resolve({}));
