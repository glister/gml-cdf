import { z } from 'zod';
import {
  approvalPolicyValueSchemaFor,
  approvalThresholdValueSchema,
  type ApprovalPolicyValue,
  type ApprovalThresholdValue,
} from '@repo/domain';
import { defineConfigKey, type ConfigKeyDef } from './registry.js';

/**
 * Per-subject-type approval configuration (core plan 09 §6, PL-016/PL-018).
 *
 * The engine is generic, so its decision points are **families** of keys rather
 * than single ones: `platform.approvals.policy.hr.leave_booking` is a different
 * value from `platform.approvals.policy.platform.pilot_signoff`, and each needs
 * its own schema-validated entry, its own default and its own audit trail.
 *
 * `defineApprovalSubject` registers a subject type's three keys at module load
 * and records it in a registry the engine services read. That registration —
 * not a row in a table — **is** what "approvals are enabled on this subject
 * type" means, and it is the right shape for two reasons:
 *
 *  - A subject type needs code anyway (its `designated` resolvers, its warning
 *    providers), so making the whole thing a code registration keeps one list to
 *    keep in step rather than two.
 *  - `defineConfigKey` validates the name grammar and the default against the
 *    schema at load, so a malformed subject registration fails on boot rather
 *    than at the first submit against it (ADR-0016 fail-fast).
 *
 * A subject type is a journal stream name, `<module>.<entity>` (ADR-0021), and
 * splits into the config namespace/key at its **last** dot — so
 * `hr.leave_booking` gives namespace `platform.approvals.policy.hr`, key
 * `leave_booking`.
 */

/** ISO-8601 day/week duration, the same shape plans 08 and 10 use for cadences. */
const cadence = z
  .string()
  .regex(/^P(?!$)(\d+D|\d+W)$/, 'an ISO-8601 day or week duration, e.g. P1D');

/** A stream name: `<module>.<entity>`, lowercase snake_case either side. */
const SUBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_]+\.[a-z][a-z0-9_]+$/;

export interface ApprovalSubjectDef {
  /** The journal stream type this configuration governs, e.g. `hr.leave_booking`. */
  readonly subjectType: string;
  /**
   * Validated against this subject type's **declared** `designatedSources`, not
   * against the permissive shape — see `approvalPolicyValueSchemaFor`. A policy
   * naming an unknown resolver is refused when it is written, rather than
   * failing at the next submit.
   */
  readonly policy: ConfigKeyDef<z.ZodType<ApprovalPolicyValue>>;
  readonly threshold: ConfigKeyDef<typeof approvalThresholdValueSchema>;
  /** Per-subject chase cadence; `null` falls back to the engine-wide default. */
  readonly reminderCadence: ConfigKeyDef<z.ZodNullable<typeof cadence>>;
  /**
   * The `designated` resolver names this subject type's policy may reference.
   * Declared here so a policy naming an unknown resolver is caught against a
   * list rather than discovered when nobody gets notified.
   */
  readonly designatedSources: readonly string[];
}

export interface DefineApprovalSubjectInput {
  subjectType: string;
  /** Who this subject type's approvals go to before anyone configures it. */
  policyDefault: ApprovalPolicyValue;
  /**
   * Whether approval is needed at all, before anyone configures it. Defaults to
   * `{ always: true }`: a subject type whose threshold has not been set yet must
   * ask a human, never wave everything through.
   */
  thresholdDefault?: ApprovalThresholdValue;
  designatedSources?: readonly string[];
  /** Plain English, shown to whoever is editing the value. */
  policyDescription: string;
  thresholdDescription: string;
  /** The owning plan, for the review trail — e.g. `'09'`, `'hr-leave'`. */
  registeredBy: string;
}

const subjects = new Map<string, ApprovalSubjectDef>();

/** Split `hr.leave_booking` into a config namespace suffix and key. */
function splitSubjectType(subjectType: string): { module: string; entity: string } {
  if (!SUBJECT_TYPE_PATTERN.test(subjectType)) {
    throw new Error(
      `invalid approval subject type '${subjectType}': must be a journal stream name, '<module>.<entity>' (ADR-0021), e.g. 'hr.leave_booking'`,
    );
  }
  const dot = subjectType.indexOf('.');
  return { module: subjectType.slice(0, dot), entity: subjectType.slice(dot + 1) };
}

/**
 * Enable approvals on a subject type: register its policy, threshold and
 * cadence-override keys, and record it for the engine to find.
 *
 * Editable by Administrator **and** HR User throughout. Who signs off what is an
 * HR policy decision, and routing it through a developer would defeat PL-016;
 * the delegation ceiling (§6) is the one Administrator-only key, because it
 * bounds how far authority can travel.
 */
export function defineApprovalSubject(input: DefineApprovalSubjectInput): ApprovalSubjectDef {
  const { module, entity } = splitSubjectType(input.subjectType);

  if (subjects.has(input.subjectType)) {
    throw new Error(
      `duplicate approval subject registration: '${input.subjectType}' is already registered`,
    );
  }

  const designatedSources = input.designatedSources ?? [];

  // The key's schema admits only this subject type's declared sources, so the
  // default policy is checked against them by `defineConfigKey` at module load
  // — and so is every later config write, which is the half that was missing.
  const policySchema = approvalPolicyValueSchemaFor(designatedSources);

  const policy = defineConfigKey({
    namespace: `platform.approvals.policy.${module}`,
    key: entity,
    schema: policySchema,
    defaultValue: input.policyDefault,
    description: input.policyDescription,
    editableBy: ['administrator', 'hr_user'],
    registeredBy: input.registeredBy,
  });

  const threshold = defineConfigKey({
    namespace: `platform.approvals.threshold.${module}`,
    key: entity,
    schema: approvalThresholdValueSchema,
    defaultValue: input.thresholdDefault ?? { always: true },
    description: input.thresholdDescription,
    editableBy: ['administrator', 'hr_user'],
    registeredBy: input.registeredBy,
  });

  const reminderCadence = defineConfigKey({
    namespace: `platform.approvals.reminder.cadence.${module}`,
    key: entity,
    schema: cadence.nullable(),
    // `null`, not a duplicate of the engine-wide default: an administrator who
    // changes the global cadence should move every subject type that has not
    // deliberately opted out of it, and a copied default would silently pin
    // this one to whatever the global value happened to be at registration.
    defaultValue: null,
    description: `How often an undecided ${input.subjectType} approval is chased, as an ISO-8601 duration. Leave unset to follow the engine-wide cadence.`,
    editableBy: ['administrator', 'hr_user'],
    registeredBy: input.registeredBy,
  });

  const def: ApprovalSubjectDef = {
    subjectType: input.subjectType,
    policy,
    threshold,
    reminderCadence,
    designatedSources,
  };
  subjects.set(input.subjectType, Object.freeze(def));
  return def;
}

/** Thrown when a subject type has no approval configuration registered. */
export class ApprovalSubjectUnknownError extends Error {
  constructor(readonly subjectType: string) {
    super(
      `approvals are not enabled for '${subjectType}': register it with defineApprovalSubject() before opening a request against it`,
    );
    this.name = 'ApprovalSubjectUnknownError';
  }
}

/** Look up a subject type's configuration, or throw. */
export function requireApprovalSubject(subjectType: string): ApprovalSubjectDef {
  const def = subjects.get(subjectType);
  if (!def) throw new ApprovalSubjectUnknownError(subjectType);
  return def;
}

export function isApprovalSubject(subjectType: string): boolean {
  return subjects.has(subjectType);
}

/** Every registered subject type — the admin surfaces' "what can be approved?". */
export function approvalSubjectTypes(): string[] {
  return [...subjects.keys()].sort();
}

/** Test-only: drop a registration so a suite can exercise the load-time rules. */
export function unregisterApprovalSubjectForTests(subjectType: string): void {
  subjects.delete(subjectType);
}
