/**
 * Outbox-relay operational tunables (core plan 02 §6). Code constants — nothing
 * here is a business decision point, and the configuration store (plan 06)
 * depends on this plan, so it can't be consumed here (circularity). Promotable
 * to the config store later if operational need arises.
 *
 * The append-time payload-size cap (`max_payload_bytes`) is enforced in
 * `@repo/db`'s `appendEvent` (`MAX_PAYLOAD_BYTES`), not here — the relay never
 * needs it because oversize rows can't be journalled in the first place.
 */
export const relayConfig = {
  /** Service Bus topic the journal is relayed to. */
  topic: 'domain-events',
  /** Max rows claimed and published per tick (`relay_batch_size`). */
  batchSize: 100,
  /** Idle wait between ticks when the outbox is drained (`relay_poll_interval_ms`). */
  pollIntervalMs: 1000,
  /** Ceiling for exponential backoff after a transient publish failure (`relay_backoff_max_ms`). */
  backoffMaxMs: 60_000,
} as const;
