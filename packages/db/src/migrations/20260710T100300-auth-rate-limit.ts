import { Kysely, sql } from 'kysely';

/**
 * Core plan 03 (PL-044): the Better Auth `rate_limit` table for database-backed
 * rate limiting, so OTP send/verify limits hold across API replicas (in-memory
 * storage would let each replica be attacked independently).
 *
 * Framework-shaped table (Better Auth model `rateLimit`): a text `id` PK plus
 * `key` (unique), `count`, and `last_request` (a unix-ms bigint). `auth.ts`
 * maps `modelName: 'rate_limit'` and `fields.lastRequest: 'last_request'`
 * onto these columns (task 9.3-1). Framework-managed, so it stays in `public`
 * and carries no ADR-0011 standard columns.
 */

// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('rate_limit')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('key', 'text', (c) => c.notNull().unique())
    .addColumn('count', 'integer', (c) => c.notNull())
    .addColumn('last_request', 'bigint', (c) => c.notNull())
    .execute();

  await sql`
    COMMENT ON TABLE rate_limit IS
      'Better Auth database-backed rate-limit storage (PL-044). Framework-managed; last_request is a unix-ms bigint.'
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('rate_limit').ifExists().execute();
}
