import { Kysely, sql } from 'kysely';

/**
 * Foundations (core plan 01, ADR-0008): create the per-module Postgres schemas.
 * Every module table is schema-qualified so a cross-module read is visible at
 * the call site (`platform.person` inside an `hr` query is a reviewable
 * violation). The `hr` schema is created empty here — its tables land with the
 * later HR-module plans; only the namespace boundary exists from the first
 * migration. Better Auth tables and Kysely's own bookkeeping stay in `public`.
 */
// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createSchema('platform').ifNotExists().execute();
  await db.schema.createSchema('hr').ifNotExists().execute();

  await sql`COMMENT ON SCHEMA platform IS 'Platform module — shared services (ADR-0008)'`.execute(
    db,
  );
  await sql`COMMENT ON SCHEMA hr IS 'HR module (ADR-0008)'`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // RESTRICT (the default): fails if any table still lives in the schema, which
  // is correct — a module's tables must be dropped by their own down migrations
  // before the namespace is removed.
  await db.schema.dropSchema('hr').ifExists().execute();
  await db.schema.dropSchema('platform').ifExists().execute();
}
