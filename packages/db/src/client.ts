import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { parse, z } from '@repo/env';
import type { DB } from './types.js';

/**
 * Postgres connection config, validated at import time. We build the pool from
 * discrete POSTGRES_* vars (not DATABASE_URL) so the shape is explicit and typed.
 */
const dbEnvSchema = z.object({
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive(),
  /**
   * TLS for the connection. Off locally (the dev and test containers speak
   * plaintext on the loopback); **on for every Azure environment**, where
   * Flexible Server sets `require_secure_transport = ON` by default and refuses
   * an unencrypted connection outright.
   *
   * Matched literally rather than with `z.coerce.boolean()`, which treats the
   * string `'false'` as `true` — the exact mistake that would silently ship a
   * plaintext production connection.
   */
  POSTGRES_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const env = parse(dbEnvSchema);

// Keep `date` (OID 1082) columns as raw 'YYYY-MM-DD' strings rather than letting
// node-postgres coerce them into JS Date objects (which drifts by timezone).
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
  max: 10,
  // `rejectUnauthorized` stays true: Azure's certificate chains to a root Node
  // already trusts, so verification costs nothing here. Turning it off is the
  // usual shortcut when a connection fails, and it downgrades TLS to
  // encryption-without-authentication — no protection against interception.
  ssl: env.POSTGRES_SSL ? { rejectUnauthorized: true } : undefined,
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});
