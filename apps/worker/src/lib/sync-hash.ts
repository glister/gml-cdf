import { createHash } from 'node:crypto';
import { canonicalProjectionJson, type OutlookEventProjection } from '@repo/domain';

/**
 * The sync hash (core plan 12 §5.2 step 3, PL-024) — one line, deliberately
 * separated from the thing that matters.
 *
 * **Why it is here, and not in `@repo/domain` or `@repo/trpc`.** §9.2 placed
 * `syncHash` in `@repo/domain`; that package bans `node:*` imports outright
 * (ADR-0009, lint-enforced), so the **canonicalisation** — which bytes get
 * hashed, and why key order must not affect them — stays pure and testable
 * there, and only the digest moves. It moved *here* rather than to `@repo/trpc`
 * (core plan 11's home for the document hash) because `@repo/trpc` is imported
 * by `apps/web`: a `node:crypto` import reachable from that package's barrel
 * lands in the browser's module graph, where it cannot resolve, and the page
 * silently fails to hydrate. Found exactly that way — the calendar screen
 * rendered its server HTML and then answered no clicks.
 *
 * This process is the only caller. That is the same inversion `document-ports.ts`
 * documents for Graph and `notification-email-channel.ts` for SMTP: concrete,
 * node-only services live in the app that owns them.
 *
 * The value is compared for **equality** with `calendar_sync_state.last_synced_hash`
 * and nothing else. It is not a security control and is never shown to anyone;
 * it exists so a redelivered amend whose projection has not moved costs a string
 * comparison instead of a Graph call.
 */
export function syncHash(projection: OutlookEventProjection): string {
  return `sha256:${createHash('sha256').update(canonicalProjectionJson(projection)).digest('hex')}`;
}
