import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineCaptureSchema,
  inductionQaCaptureSchema,
  requireCaptureSchema,
  unregisterCaptureSchemaForTests,
  validateCaptureData,
  CaptureSchemaUnknownError,
} from './capture-schemas.js';

/**
 * The response-capture registry's tests (core plan 11 §1 anti-scope, PL-009).
 *
 * The load-time rules are the point. This registry is what makes "controlled
 * response actions, not an open-ended form builder" a mechanical property rather
 * than a promise in a scope section — so the tests that matter are the ones
 * proving a registration cannot be made permissive or incoherent.
 */

const registered: string[] = [];

function register(key: string) {
  registered.push(key);
  return defineCaptureSchema({
    key,
    fields: { answer: z.string().min(1) },
    questions: [{ name: 'answer', label: 'Your answer', kind: 'text', required: true }],
    description: 'test',
    registeredBy: 'test',
  });
}

afterAll(() => {
  for (const key of registered) unregisterCaptureSchemaForTests(key);
});

describe('defineCaptureSchema — the load-time rules', () => {
  it('registers a schema and its rendering contract together', () => {
    const def = register('cap_ok');
    expect(def.key).toBe('cap_ok');
    expect(def.questions).toHaveLength(1);
  });

  it('rejects a key that is not a lowercase identifier', () => {
    expect(() =>
      defineCaptureSchema({
        key: 'Not-A-Key',
        fields: { a: z.string() },
        questions: [{ name: 'a', label: 'A', kind: 'text', required: true }],
        description: 'x',
        registeredBy: 'test',
      }),
    ).toThrow(/lowercase identifier/);
  });

  it('rejects a duplicate registration', () => {
    register('cap_dupe');
    expect(() => register('cap_dupe')).toThrow(/duplicate/);
  });

  it('rejects a field with no question — a required value the form never asks for', () => {
    // The subject could never complete the document, and nothing would say why.
    expect(() =>
      defineCaptureSchema({
        key: 'cap_orphan_field',
        fields: { a: z.string(), b: z.string() },
        questions: [{ name: 'a', label: 'A', kind: 'text', required: true }],
        description: 'x',
        registeredBy: 'test',
      }),
    ).toThrow(/same set/);
  });

  it('rejects a question with no field — an answer that would be discarded', () => {
    expect(() =>
      defineCaptureSchema({
        key: 'cap_orphan_question',
        fields: { a: z.string() },
        questions: [
          { name: 'a', label: 'A', kind: 'text', required: true },
          { name: 'b', label: 'B', kind: 'text', required: true },
        ],
        description: 'x',
        registeredBy: 'test',
      }),
    ).toThrow(/same set/);
  });
});

describe('validateCaptureData', () => {
  it('returns the parsed answers when they satisfy the schema', () => {
    expect(
      validateCaptureData('induction_qa', {
        preferred_name: 'Jan',
        read_handbook: true,
        ppe_size: 'l',
      }),
    ).toEqual({ preferred_name: 'Jan', read_handbook: true, ppe_size: 'l' });
  });

  it('returns null on a missing answer, rather than throwing', () => {
    // The caller turns this into a guard result, not an exception.
    expect(validateCaptureData('induction_qa', { preferred_name: 'Jan' })).toBeNull();
  });

  it('returns null on an answer outside the declared choices', () => {
    expect(
      validateCaptureData('induction_qa', {
        preferred_name: 'Jan',
        read_handbook: true,
        ppe_size: 'xxxl',
      }),
    ).toBeNull();
  });

  it('rejects an unknown key — answers are frozen onto the document for its life', () => {
    expect(
      validateCaptureData('induction_qa', {
        preferred_name: 'Jan',
        read_handbook: true,
        ppe_size: 'l',
        national_insurance_number: 'QQ123456C',
      }),
    ).toBeNull();
  });

  it('refuses a confirmation answered "no"', () => {
    // `z.literal(true)`, not `z.boolean()`: a confirmation that accepts "no" is
    // not a confirmation, and that belongs in the schema rather than in a
    // client-side `disabled` attribute.
    expect(
      validateCaptureData('induction_qa', {
        preferred_name: 'Jan',
        read_handbook: false,
        ppe_size: 'l',
      }),
    ).toBeNull();
  });

  it('throws for a schema nobody registered', () => {
    expect(() => validateCaptureData('no_such_schema', {})).toThrow(CaptureSchemaUnknownError);
  });
});

describe('the demonstration schema', () => {
  it('asks nothing special-category, and that is the example it sets', () => {
    const def = requireCaptureSchema('induction_qa');
    expect(def).toBe(inductionQaCaptureSchema);
    expect(def.questions.map((q) => q.name)).toEqual([
      'preferred_name',
      'read_handbook',
      'ppe_size',
    ]);
  });
});
