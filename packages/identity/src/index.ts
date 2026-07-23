/**
 * `@repo/identity` — the identity adapter (ADR-0014).
 *
 * This package is the ONLY code allowed to read or write the Better Auth
 * framework tables (`user`, `account`, `session`). Domain code, tRPC procedures
 * and worker jobs reach identity exclusively through the functions exported
 * here — never by querying `user`/`account`/`session` directly. Keeping the
 * framework coupling in one place is what makes Better Auth swappable and the
 * durable `platform.person` the stable anchor.
 *
 * Adapter functions land in task 9.2 (core plan 03 §5.1).
 */

export {};
