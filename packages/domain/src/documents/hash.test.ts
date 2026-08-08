import { describe, expect, it } from 'vitest';
import {
  documentHashHex,
  formatDocumentHash,
  hashesMatch,
  isDocumentHash,
  DocumentHashError,
} from './hash.js';

/**
 * The document-hash format's tests (core plan 11 §9.2, PL-011).
 *
 * Small surface, high stakes: every one of these functions sits between "this
 * person signed a document" and "this person signed **these bytes**", and the
 * failure mode of getting one wrong is a guard that passes when it should not.
 */

const HEX = 'a'.repeat(64);
const HASH = `sha256:${HEX}`;

describe('formatDocumentHash', () => {
  it('produces the canonical form', () => {
    expect(formatDocumentHash(HEX)).toBe(HASH);
  });

  it('lowercases uppercase hex — the same number, normalised at the door', () => {
    // Accepting one casing here is exactly what lets comparison downstream stay
    // exact rather than case-insensitive.
    expect(formatDocumentHash('A'.repeat(64))).toBe(HASH);
  });

  it.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['not hex', 'g'.repeat(64)],
    ['already prefixed', HASH],
    ['empty', ''],
  ])('throws on %s rather than coercing', (_label, input) => {
    // Silently coercing would produce a hash-shaped value that matches nothing —
    // the worst possible failure for this field, because it looks fine.
    expect(() => formatDocumentHash(input)).toThrow(DocumentHashError);
  });
});

describe('isDocumentHash', () => {
  it.each([
    [HASH, true],
    [`sha256:${'A'.repeat(64)}`, false], // uppercase is not canonical
    [`md5:${HEX}`, false],
    [HEX, false], // no prefix
    ['', false],
    [null, false],
    [undefined, false],
    [{ toString: () => HASH }, false],
  ])('%s → %s', (value, expected) => {
    expect(isDocumentHash(value)).toBe(expected);
  });
});

describe('documentHashHex', () => {
  it('returns the digest without its prefix', () => {
    expect(documentHashHex(HASH)).toBe(HEX);
  });

  it('refuses a malformed value', () => {
    expect(() => documentHashHex(HEX)).toThrow(DocumentHashError);
  });
});

describe('hashesMatch', () => {
  it('matches two identical canonical hashes', () => {
    expect(hashesMatch(HASH, HASH)).toBe(true);
  });

  it('does not match different hashes', () => {
    expect(hashesMatch(HASH, `sha256:${'b'.repeat(64)}`)).toBe(false);
  });

  it('does not match on case — comparison is exact, not normalising', () => {
    // A hash comparison that normalises is one that can be argued with, and this
    // one has to survive being argued with in front of a tribunal (R2).
    expect(hashesMatch(HASH, `sha256:${'A'.repeat(64)}`)).toBe(false);
  });

  it.each([
    ['two nulls', null, null],
    ['two empty strings', '', ''],
    ['two undefineds', undefined, undefined],
    ['a hash and a null', HASH, null],
  ])('refuses %s, even when they are equal as values', (_label, a, b) => {
    // Without the well-formedness requirement, every guard built on this
    // function passes for a document that was never rendered.
    expect(hashesMatch(a, b)).toBe(false);
  });
});
