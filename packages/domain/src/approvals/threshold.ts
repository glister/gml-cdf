import { z } from 'zod';

/**
 * Approval thresholds as configuration, not code (core plan 09 §6, PL-018).
 *
 * SoW §5.7 names training spend as the example: "requests above £X need
 * approval". The requirement is not the number — it is that **changing the
 * number is a configuration edit rather than a release**. So the rule is a
 * config value, evaluated here against the request's PII-minimal `context`, and
 * nothing about the amount, the field name or the comparison lives in code.
 *
 * The evaluation is deliberately tiny. A general expression language would be a
 * rules engine, which §1's anti-scope rules out for exactly the reason ADR-0013
 * gives about guards: an engine nobody can predict the behaviour of is worse
 * than a release.
 */

/** Every request of this subject type needs approval. The safe default. */
export const approvalThresholdAlwaysSchema = z.strictObject({ always: z.literal(true) });

/**
 * Approval is needed only when `context[field]` exceeds `value`.
 *
 * `gt` and `gte` are both offered because "over £500" and "£500 or more" are
 * different policies and a business user should not have to encode one as the
 * other by adjusting the number.
 */
export const approvalThresholdComparisonSchema = z.strictObject({
  field: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'a context field name, e.g. amount'),
  op: z.enum(['gt', 'gte']),
  value: z.number().finite(),
});

export const approvalThresholdValueSchema = z.union([
  approvalThresholdAlwaysSchema,
  approvalThresholdComparisonSchema,
]);

export type ApprovalThresholdValue = z.infer<typeof approvalThresholdValueSchema>;

/** Why approval was or was not required — journalled, and shown to the user. */
export type ApprovalThresholdReason =
  /** The rule is `{ always: true }`. */
  | 'always'
  /** The context value cleared the threshold. */
  | 'above_threshold'
  /** The context value did not clear it — this is the auto-approve path. */
  | 'below_threshold'
  /**
   * The rule names a field the context does not carry, or carries as a
   * non-number. **Approval is required.** A threshold that cannot be evaluated
   * must never silently auto-approve: the failure mode of erring towards a
   * human is a redundant sign-off, and of erring the other way is spend nobody
   * authorised.
   */
  | 'unevaluable';

export interface ApprovalThresholdOutcome {
  required: boolean;
  reason: ApprovalThresholdReason;
}

/**
 * Does this request need approval at all (PL-018)?
 *
 * Exhaustive over the value union — a future third rule shape is a compile
 * error here rather than a silent fall-through to "no approval needed".
 */
export function evaluateApprovalThreshold(
  threshold: ApprovalThresholdValue,
  context: Readonly<Record<string, unknown>>,
): ApprovalThresholdOutcome {
  if ('always' in threshold) return { required: true, reason: 'always' };

  const raw = context[threshold.field];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { required: true, reason: 'unevaluable' };
  }

  const clears = threshold.op === 'gt' ? raw > threshold.value : raw >= threshold.value;
  return clears
    ? { required: true, reason: 'above_threshold' }
    : { required: false, reason: 'below_threshold' };
}
