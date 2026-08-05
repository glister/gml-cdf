import type { ConfigRef } from './types.js';

/**
 * The pilot shape's two decision points (core plan 07 §6), named once so the
 * definition's `config:` references, the guard that reads the resolved value,
 * and the key registration in `@repo/config` can never drift apart.
 *
 * The names themselves are the contract — `<module>.<area>.<key>` where the
 * module is a Postgres schema (core plan 06 §6). `@repo/domain` deliberately
 * knows only the *names*: resolving them is the runtime's job, and a guard that
 * reached into the configuration store would break the purity rule that makes
 * every decision here reproducible (ADR-0009/0013).
 */

/** Who may approve or reject a demo request — the `by` decision point. */
export const DEMO_APPROVER_ROLE_KEY = 'platform.workflow.demo.approver_role';
export const DEMO_APPROVER_ROLE_REF: ConfigRef = `config:${DEMO_APPROVER_ROLE_KEY}`;

/** How long a demo request stands before the expiry timer fires. */
export const DEMO_EXPIRY_HOURS_KEY = 'platform.workflow.demo.expiry_hours';
export const DEMO_EXPIRY_HOURS_REF: ConfigRef = `config:${DEMO_EXPIRY_HOURS_KEY}`;
