import { z } from 'zod';

/**
 * Identity configuration (core plan 03 §6). Plan 06's `platform.config_entry`
 * store transitively depends on this plan, so these decision points ship first
 * as code-registered, Zod-validated constants and **migrate to the config store
 * when plan 06 lands** (task 9.5-3). The key names are final now, so that move
 * is a value relocation only.
 *
 * Security parameters (OTP length/lifetime, rate-limit rules) are deliberately
 * NOT here — they are release-managed code-level settings in `auth.ts` (§6).
 */

const identityConfigSchema = z.object({
  /** `identity.external.default_access_days` — default external access window (PL-042). */
  externalDefaultAccessDays: z.number().int().positive(),
  /** `identity.external.expiry_warning_days` — lead time for the expiry warning (→ plan 10). */
  externalExpiryWarningDays: z.number().int().positive(),
  /** `identity.duplicate.recent_window_days` — the duplicate-scan "recent record" window (PL-037). */
  duplicateRecentWindowDays: z.number().int().positive(),
});

export type IdentityConfig = z.infer<typeof identityConfigSchema>;

/** The Phase-1 defaults (§6). Validated at import so a bad edit fails on boot. */
export const identityConfig: IdentityConfig = identityConfigSchema.parse({
  externalDefaultAccessDays: 90,
  externalExpiryWarningDays: 7,
  duplicateRecentWindowDays: 365,
});
