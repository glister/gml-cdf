import { faker } from '@faker-js/faker';
import { type Kysely, sql } from 'kysely';
import type { DB } from './types.js';
import type { NewSession, NewUser } from './index.js';

/**
 * Test fixtures for `@repo/db`. Pure factories (no DB connection) plus a
 * `truncateAll` helper for isolating integration tests that run against a real
 * Postgres. Imported as `@repo/db/test-support`.
 */

export function makeUser(overrides: Partial<NewUser> = {}): NewUser {
  return {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email().toLowerCase(),
    email_verified: true,
    ...overrides,
  };
}

export function makeSession(userId: string, overrides: Partial<NewSession> = {}): NewSession {
  return {
    id: faker.string.uuid(),
    user_id: userId,
    token: faker.string.alphanumeric(40),
    expires_at: faker.date.future(),
    ...overrides,
  };
}

/** Wipe every auth table. Use in `beforeEach` for integration tests. */
export async function truncateAll(db: Kysely<DB>): Promise<void> {
  await sql`truncate table "account", "session", "verification", "user" restart identity cascade`.execute(
    db,
  );
}
