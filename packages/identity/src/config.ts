import { z } from 'zod';

/**
 * Identity configuration (core plan 03 §6). Plan 06's `platform.config_entry`
 * store transitively depends on this plan, so these decision points shipped
 * first as code-registered, Zod-validated constants and **migrate to the config
 * store as each is taken up by its owning plan**.
 *
 * **`externalDefaultAccessDays` has migrated** (core plan 06 §9.5-T2,
 * 2026-08-05): it is now `platform.identity.external_access_default_days` in
 * the store, registered in `@repo/trpc`'s config registry, read with
 * `getConfig` by `platform.identity.createPerson`, and editable in the admin UI
 * without a release. It is deliberately **not** left here as well — two places
 * to change a threshold is precisely the failure the store exists to prevent,
 * and a stale constant is the one that gets read by mistake.
 *
 * The two below stay for now and follow the same route when their consumers
 * land: the expiry-warning lead time with plan 10 (notification cadences), the
 * duplicate-scan window with whichever plan makes it tunable.
 *
 * Security parameters (OTP length/lifetime, rate-limit rules) are deliberately
 * NOT here — they are release-managed code-level settings in `auth.ts` (§6).
 */

const identityConfigSchema = z.object({
  /** `identity.external.expiry_warning_days` — lead time for the expiry warning (→ plan 10). */
  externalExpiryWarningDays: z.number().int().positive(),
  /** `identity.duplicate.recent_window_days` — the duplicate-scan "recent record" window (PL-037). */
  duplicateRecentWindowDays: z.number().int().positive(),
});

export type IdentityConfig = z.infer<typeof identityConfigSchema>;

/** The Phase-1 defaults (§6). Validated at import so a bad edit fails on boot. */
export const identityConfig: IdentityConfig = identityConfigSchema.parse({
  externalExpiryWarningDays: 7,
  duplicateRecentWindowDays: 365,
});
