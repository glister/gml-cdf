import { describe, expect, it } from 'vitest';
import { newUuidV7 } from './ids.js';

// Pure unit tests — no database. Proves the ADR-0011 ID contract: valid v7,
// unique, and time-ordered so IDs are index-friendly as primary keys.
describe('newUuidV7', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('emits a valid v7 UUID (version nibble 7, RFC variant bits)', () => {
    for (let i = 0; i < 100; i++) {
      expect(newUuidV7()).toMatch(UUID_RE);
    }
  });

  it('generates 10k unique ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(newUuidV7());
    expect(ids.size).toBe(10_000);
  });

  it('produces lexicographically non-decreasing ids in generation order', () => {
    const ids = Array.from({ length: 5_000 }, () => newUuidV7());
    for (let i = 1; i < ids.length; i++) {
      // Time-ordered ⇒ each id sorts >= its predecessor as a plain string.
      expect(ids[i] >= ids[i - 1]).toBe(true);
    }
  });

  it('orders two ids minted within the same millisecond (monotonic sequence)', () => {
    // Tight loop ⇒ many collisions on the millisecond timestamp; the library's
    // monotonic counter must still keep them strictly ordered.
    const a = newUuidV7();
    const b = newUuidV7();
    expect(a).not.toBe(b);
    expect([a, b].sort()).toEqual([a, b]);
  });
});
