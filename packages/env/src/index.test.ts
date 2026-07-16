import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parse, safeParse } from './index.js';

const schema = z.object({
  PORT: z.coerce.number().int().positive(),
  NAME: z.string().min(1),
});

describe('parse', () => {
  it('returns typed data on success', () => {
    const result = parse(schema, { PORT: '3000', NAME: 'api' });
    expect(result).toEqual({ PORT: 3000, NAME: 'api' });
  });

  it('throws a readable error listing missing required vars', () => {
    expect(() => parse(schema, { PORT: '3000' })).toThrowError(/NAME: /);
  });

  it('throws when a value has the wrong type', () => {
    expect(() => parse(schema, { PORT: 'not-a-number', NAME: 'api' })).toThrowError(
      /Invalid environment configuration/,
    );
  });
});

describe('safeParse', () => {
  it('does not throw; returns a discriminated union', () => {
    const ok = safeParse(schema, { PORT: '1', NAME: 'x' });
    expect(ok.success).toBe(true);

    const bad = safeParse(schema, {});
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('accepts a custom source (e.g. import.meta.env)', () => {
    const fakeViteEnv = { PORT: '5173', NAME: 'web' };
    const result = parse(schema, fakeViteEnv);
    expect(result.PORT).toBe(5173);
  });
});
