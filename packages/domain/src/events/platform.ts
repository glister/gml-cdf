import { z } from 'zod';
import { defineEvent } from './define.js';

/**
 * Event types owned by the `platform` module (core plan 02 §4.2). Payload keys
 * are camelCase, PII-minimal (ADR-0019/0021): surrogate IDs, deltas and
 * decisions — never names, emails or special-category detail. Schemas are
 * strict, so an accidental profile-row spread is rejected at validation.
 *
 * Later plans register their own module's event types the same way (03 identity,
 * 06 config, 11 documents, 16 migration, …) and add them to `eventTypes`.
 */

/**
 * The pilot slice's demo event (§4.2). Emitted by `platform.journal.demoPing`,
 * relayed, and consumed by the `pilot-demo` subscription — the end-to-end smoke
 * probe of the rail. `note` is a short free-text string; nothing PII-bearing.
 */
export const platformDemoPinged = defineEvent(
  'platform.demo.pinged',
  1,
  z.strictObject({ note: z.string().max(200) }),
);
