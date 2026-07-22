import { Kysely, sql } from 'kysely';

/**
 * Foundations (core plan 01, ADR-0011): the two shared trigger functions every
 * later table convention is built from.
 *
 * `platform.append_only_guard()` makes immutability a *database property*: it
 * fires BEFORE UPDATE/DELETE for every row regardless of the caller's
 * privileges, so even the table owner (which the Phase 1 dev role is) cannot
 * silently rewrite history. Its single future exception is the dedicated
 * erasure role (`cdf_erasure`), created by plan 16 (ADR-0019) for GDPR
 * redaction; the check is defensive so this function is valid before that role
 * exists — until then no session can pass the guard.
 *
 * `platform.set_updated_at()` stamps `updated_at = now()` on UPDATE, so
 * timestamp maintenance is one trigger, not per-procedure discipline.
 */
// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE FUNCTION platform.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- Single exception (ADR-0011 / ADR-0019): the dedicated erasure role,
      -- created by plan 16 as 'cdf_erasure'. Checked defensively so this
      -- function is valid before that role exists. Recognition is
      -- current_user-based (role membership), never a session GUC.
      IF to_regrole('cdf_erasure') IS NOT NULL
         AND pg_has_role(current_user, 'cdf_erasure', 'MEMBER') THEN
        RETURN COALESCE(NEW, OLD);
      END IF;
      RAISE EXCEPTION 'append-only violation: % on %.%',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END;
    $$;
  `.execute(db);

  await sql`
    CREATE FUNCTION platform.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$;
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS platform.set_updated_at()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS platform.append_only_guard()`.execute(db);
}
