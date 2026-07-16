import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from './test-support.js';

// Pure-factory unit tests (no DB). Keyset/sort/filter correctness is validated
// separately against a real Postgres in @repo/trpc integration tests.
describe('makeUser', () => {
  it('produces a valid insertable user with a lowercase email', () => {
    const user = makeUser();
    expect(user.id).toBeTruthy();
    expect(user.email).toBe(user.email?.toLowerCase());
    expect(user.name).toBeTruthy();
  });

  it('applies overrides', () => {
    const user = makeUser({ email: 'x@y.z', role: 'admin' });
    expect(user.email).toBe('x@y.z');
    expect(user.role).toBe('admin');
  });

  it('generates distinct ids across calls', () => {
    expect(makeUser().id).not.toBe(makeUser().id);
  });
});

describe('makeSession', () => {
  it('links to the given user and sets a future expiry', () => {
    const session = makeSession('user-123');
    expect(session.user_id).toBe('user-123');
    expect(new Date(session.expires_at as string | Date).getTime()).toBeGreaterThan(Date.now());
  });
});
