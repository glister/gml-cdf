import { Kysely, sql } from 'kysely';

/**
 * Better Auth schema: base tables (user, session, account, verification) plus the
 * admin plugin columns (user.role/banned/ban_reason/ban_expires,
 * session.impersonated_by). Columns are snake_case; the app-side `auth` config
 * maps Better Auth's camelCase fields onto them.
 *
 * Generated from `@better-auth/cli generate` against the configured auth instance
 * (email/password + emailOTP + admin), then hand-ported to Kysely.
 */
// The migration API is schema-shaped, not typed against our DB interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('user')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('email_verified', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('image', 'text')
    .addColumn('role', 'text', (c) =>
      c
        .notNull()
        .defaultTo('agent')
        .check(sql`role in ('admin', 'agent')`),
    )
    .addColumn('banned', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('ban_reason', 'text')
    .addColumn('ban_expires', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('session')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('token', 'text', (c) => c.notNull().unique())
    .addColumn('ip_address', 'text')
    .addColumn('user_agent', 'text')
    .addColumn('user_id', 'text', (c) => c.notNull().references('user.id').onDelete('cascade'))
    .addColumn('impersonated_by', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('account')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('provider_id', 'text', (c) => c.notNull())
    .addColumn('user_id', 'text', (c) => c.notNull().references('user.id').onDelete('cascade'))
    .addColumn('access_token', 'text')
    .addColumn('refresh_token', 'text')
    .addColumn('id_token', 'text')
    .addColumn('access_token_expires_at', 'timestamptz')
    .addColumn('refresh_token_expires_at', 'timestamptz')
    .addColumn('scope', 'text')
    .addColumn('password', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('verification')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('identifier', 'text', (c) => c.notNull())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('session_user_id_idx').on('session').column('user_id').execute();
  await db.schema.createIndex('account_user_id_idx').on('account').column('user_id').execute();
  await db.schema
    .createIndex('verification_identifier_idx')
    .on('verification')
    .column('identifier')
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('account').ifExists().execute();
  await db.schema.dropTable('session').ifExists().execute();
  await db.schema.dropTable('verification').ifExists().execute();
  await db.schema.dropTable('user').ifExists().execute();
}
