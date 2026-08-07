import type { NotificationDeliveryRecord, NotificationRecord } from '@repo/db';
import type { NotificationChannel } from './constants.js';

/**
 * The channel-adapter seam (core plan 10 §5.3) — **the shape push slots into
 * later without a schema change.**
 *
 * An adapter's whole job is "get this one delivery to this one person on this
 * one channel, and tell me whether it worked". It never resolves recipients,
 * never decides whether a channel is enabled, never retries and never touches
 * the delivery row: the dispatcher owns all of that, so adding a channel is
 * adding a `send` function rather than editing a pipeline.
 *
 * ## Why the registry, rather than importing the adapters
 *
 * The in-app adapter needs nothing but the row, so it is registered here. The
 * **email adapter is registered by `apps/worker`**, because it needs
 * `@repo/email` — and `@repo/trpc` is imported by the web client, so a static
 * import of `nodemailer`/`resend` from this package would drag a mail transport
 * into the browser bundle. Registration inverts that: the app that already owns
 * service construction hands the adapter in, and this package stays free of
 * every concrete service (the same rule the tRPC context follows for
 * email/sms/logging).
 *
 * A channel with **no** registered adapter is not silently skipped. The
 * dispatcher records the attempt as failed with a message naming the missing
 * adapter, so a misconfigured process looks like a misconfigured process rather
 * than like a quiet Tuesday.
 *
 * ## The contract every adapter must honour
 *
 * 1. **Idempotent per delivery row.** At-least-once delivery means `send` will
 *    be called twice for one row; a second in-app send is a no-op, and a second
 *    email is an accepted cost (the alternative — a provider-side idempotency
 *    key we do not have — is not on offer).
 * 2. **Return, never throw, for a delivery failure.** A returned `{ ok: false }`
 *    lands on the row as `last_error` and schedules a retry. Throwing abandons
 *    the whole message and retries *every* delivery in it, including the ones
 *    that already succeeded.
 * 3. **Render nothing new.** The title and body were produced once, from
 *    registry-validated parameters, when the notification was requested. An
 *    adapter that interpolated anything else could put on one channel what
 *    SA-023 keeps off all of them.
 */

export interface ChannelSendContext {
  delivery: NotificationDeliveryRecord;
  notification: NotificationRecord;
  /** Resolved at dispatch time from `platform.person` — never carried on a queue. */
  recipient: { personId: string; email: string | null; displayName: string };
}

export type ChannelSendResult =
  { ok: true; providerRef?: string | null } | { ok: false; error: string };

export interface ChannelAdapter {
  readonly channel: NotificationChannel;
  /** Attempt one delivery. Must be safe to re-run for the same delivery row. */
  send(ctx: ChannelSendContext): Promise<ChannelSendResult>;
}

const adapters = new Map<NotificationChannel, ChannelAdapter>();

/**
 * Register the adapter for a channel. Duplicate registration throws — two
 * adapters for one channel would make delivery depend on import order, and the
 * losing one would fail silently.
 */
export function registerChannelAdapter(adapter: ChannelAdapter): void {
  if (adapters.has(adapter.channel)) {
    throw new Error(
      `duplicate channel adapter registration: '${adapter.channel}' is already registered`,
    );
  }
  adapters.set(adapter.channel, adapter);
}

/** The adapter for a channel, or `undefined` if nothing registered one. */
export function channelAdapter(channel: NotificationChannel): ChannelAdapter | undefined {
  return adapters.get(channel);
}

/** Every channel with a live adapter — used by the conformance test. */
export function registeredChannels(): NotificationChannel[] {
  return [...adapters.keys()];
}

/** Test-only: drop a registration so a suite can substitute a stub. */
export function unregisterChannelAdapterForTests(channel: NotificationChannel): void {
  adapters.delete(channel);
}

/**
 * The in-app adapter: **the delivery row is the delivery.**
 *
 * There is nothing to send. The inbox query reads `notification_delivery` rows
 * with `channel = 'in_app'` and `status = 'sent'`, so marking the row sent *is*
 * making it visible — which is why this channel cannot fail, has no provider
 * reference, and needs no retry. It ships first for exactly that reason: the
 * only channel with no third party in it.
 */
export const inAppAdapter: ChannelAdapter = {
  channel: 'in_app',
  send: () => Promise.resolve({ ok: true }),
};

registerChannelAdapter(inAppAdapter);
