import { createHash } from 'node:crypto';
import { canonicalProjectionJson, type OutlookEventProjection } from '@repo/domain';

/**
 * The sync hash (core plan 12 §5.2 step 3, PL-024) — one line, deliberately
 * separated from the thing that matters.
 *
 * **Why this is not in `@repo/domain`.** §9.2 placed `syncHash` there; that
 * package bans `node:*` imports outright (ADR-0009, lint-enforced). The same
 * split core plan 11 made for the document hash applies here for the same
 * reason: the **canonicalisation** — which bytes get hashed, and why key order
 * must not affect them — is the part that decides whether the amend no-op guard
 * works at all, and it stays pure and testable in
 * `@repo/domain/calendar/outlook-projection.ts`. Only the digest lives here.
 *
 * The value is compared for **equality** with `calendar_sync_state.last_synced_hash`
 * and nothing else. It is not a security control and is never shown to anyone;
 * it exists so a redelivered amend whose projection has not moved costs a string
 * comparison instead of a Graph call.
 */
export function syncHash(projection: OutlookEventProjection): string {
  return `sha256:${createHash('sha256').update(canonicalProjectionJson(projection)).digest('hex')}`;
}
