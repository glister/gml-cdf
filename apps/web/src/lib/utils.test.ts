import { describe, expect, it } from 'vitest';
import { cn } from './utils.js';

describe('cn', () => {
  it('merges conditional classes', () => {
    expect(cn('a', false && 'b', 'c')).toBe('a c');
  });

  it('de-dupes conflicting tailwind utilities (last wins)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });
});
