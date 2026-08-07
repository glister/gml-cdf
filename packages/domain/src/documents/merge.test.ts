import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  deriveMergeFields,
  escapeHtml,
  mergeTemplate,
  parseMergeTokens,
  renderMerge,
  validateMergeData,
  MergeContractError,
  MergeDataError,
} from './merge.js';
import { defineMergeContext, unregisterMergeContextForTests } from './merge-contexts.js';

/**
 * The merge engine's unit tests (core plan 11 §10 row 1). No database, no mocks,
 * no clock — the property `@repo/domain` exists to have (ADR-0009).
 *
 * The escaping block is the one that earns its keep. Merged values are
 * user-supplied by definition (a display name, an agency's spelling of an
 * address), and the output is HTML that becomes a PDF someone signs. R6 is the
 * risk; these are its mitigation, asserted rather than reviewed.
 */

/** A second context, so "declared but not registered" and its inverse differ. */
const testContext = defineMergeContext({
  name: 'widget',
  fields: {
    label: z.string(),
    count: z.number(),
    active: z.boolean(),
    note: z.string().nullable().optional(),
  },
  description: 'A test-only context.',
  registeredBy: 'test',
});
void testContext;

describe('parseMergeTokens', () => {
  it('finds every occurrence in document order, duplicates included', () => {
    const tokens = parseMergeTokens(
      '<p>{{person.full_name}}, {{person.email}}, {{person.full_name}}</p>',
    );
    expect(tokens.map((t) => t.path)).toEqual([
      'person.full_name',
      'person.email',
      'person.full_name',
    ]);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(parseMergeTokens('{{  person.full_name  }}')[0]?.path).toBe('person.full_name');
  });

  it('ignores things that only look like tokens', () => {
    // A single brace, a missing dot, an uppercase context, a nested path: none
    // of these is the syntax, and quietly accepting any of them would mean the
    // declared field list and the rendered output disagree.
    const tokens = parseMergeTokens(
      '{person.full_name} {{personfullname}} {{Person.full_name}} {{person.address.line1}}',
    );
    expect(tokens).toEqual([]);
  });

  it('returns the same result when called twice on the same string', () => {
    // A module-level /g regex carries `lastIndex` between calls; the second call
    // would return nothing. The classic way a pure-looking function stops being
    // one, and worth an assertion rather than a comment.
    const body = '<p>{{person.full_name}}</p>';
    expect(parseMergeTokens(body)).toEqual(parseMergeTokens(body));
  });
});

describe('deriveMergeFields — the template-save contract (§4.5)', () => {
  it('derives the distinct declared fields, with required-ness from the schema', () => {
    const fields = deriveMergeFields(
      '<p>Dear {{person.first_name}} {{person.last_name}},</p><p>{{person.first_name}}</p>',
      ['person'],
    );
    expect(fields.map((f) => f.path)).toEqual(['person.first_name', 'person.last_name']);
    // Nullable-but-present: the bag must say something about it, and "we hold
    // none" is a valid thing to say.
    expect(fields.every((f) => f.required)).toBe(true);
  });

  it('marks an optional field as not required', () => {
    const [field] = deriveMergeFields('{{widget.note}}', ['widget']);
    expect(field).toMatchObject({ path: 'widget.note', required: false });
  });

  it('rejects a token whose context is not registered', () => {
    expect(() => deriveMergeFields('{{nobody.field}}', ['nobody'])).toThrow(MergeContractError);
  });

  it('rejects a token drawing on a context the template did not declare', () => {
    // The context is real; this template just never said it was entitled to it.
    // Rendering it would mean generate had to supply a bag the template's own
    // metadata never asked for.
    expect(() => deriveMergeFields('{{person.full_name}}', ['widget'])).toThrow(/does not declare/);
  });

  it('rejects a field the context does not have, and names the ones it does', () => {
    try {
      deriveMergeFields('{{person.salary}}', ['person']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MergeContractError);
      expect((error as MergeContractError).message).toContain('full_name');
    }
  });

  it('reports every problem at once, not just the first', () => {
    try {
      deriveMergeFields('{{person.salary}} {{nobody.at_all}} {{person.dob}}', ['person']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as MergeContractError).problems).toHaveLength(3);
    }
  });
});

describe('validateMergeData — the generation contract (§4.5)', () => {
  const bag = {
    person: { full_name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', email: null },
  };

  it('accepts and returns the parsed bag', () => {
    expect(validateMergeData(bag, ['person'])).toEqual(bag);
  });

  it('rejects a missing required field', () => {
    expect(() => validateMergeData({ person: { full_name: 'Jane Doe' } }, ['person'])).toThrow(
      MergeDataError,
    );
  });

  it('rejects an unknown key inside a context', () => {
    // This is the rule that stops a profile row being spread into merge_data and
    // frozen onto the document for its whole life (ADR-0019, plan 16).
    expect(() =>
      validateMergeData({ person: { ...bag.person, date_of_birth: '1990-01-01' } }, ['person']),
    ).toThrow(MergeDataError);
  });

  it('rejects a context the template did not declare', () => {
    expect(() => validateMergeData({ ...bag, widget: { label: 'x' } }, ['person'])).toThrow(
      MergeDataError,
    );
  });
});

describe('renderMerge — escaping and the one-pass rule (R6)', () => {
  it('substitutes values into the body', () => {
    const { html } = renderMerge('<p>Dear {{person.first_name}},</p>', {
      person: { first_name: 'Jane' },
    });
    expect(html).toBe('<p>Dear Jane,</p>');
  });

  it('escapes markup in a merged value so it renders inert', () => {
    const { html } = renderMerge('<p>{{person.full_name}}</p>', {
      person: { full_name: '<script>alert(1)</script>' },
    });
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).not.toContain('<script>');
  });

  it('escapes both quote forms, because a token may sit in an attribute', () => {
    const { html } = renderMerge('<a title="{{person.full_name}}">x</a>', {
      person: { full_name: 'O\'Neill " onmouseover=alert(1)' },
    });
    expect(html).toContain('&#39;');
    expect(html).toContain('&quot;');
    // The attribute cannot be broken out of, which is the point.
    expect(html).toBe('<a title="O&#39;Neill &quot; onmouseover=alert(1)">x</a>');
  });

  it('does NOT re-scan its own output — a value containing a token stays literal', () => {
    // The security property, not an optimisation: without one-pass rendering, a
    // person's own display name could pull another context's fields into their
    // letter.
    const { html } = renderMerge('<p>{{person.full_name}} / {{person.email}}</p>', {
      person: { full_name: '{{person.email}}', email: 'secret@example.com' },
    });
    expect(html).toBe('<p>{{person.email}} / secret@example.com</p>');
    // Rendered exactly once: the injected token text survives as text.
    expect(html.match(/secret@example\.com/g)).toHaveLength(1);
  });

  it('renders null blank and booleans as Yes/No', () => {
    const { html } = renderMerge('[{{widget.note}}][{{widget.active}}]', {
      widget: { note: null, active: false },
    });
    expect(html).toBe('[][No]');
  });

  it('renders an absent value blank and reports it, rather than leaving the token', () => {
    // A letter that reaches someone with `{{person.last_name}}` printed on it is
    // worse than one with a gap — and the caller gets the list either way.
    const { html, blanks } = renderMerge('<p>{{person.last_name}}</p>', { person: {} });
    expect(html).toBe('<p></p>');
    expect(blanks).toEqual(['person.last_name']);
  });

  it('is idempotent — re-rendering merged output changes nothing', () => {
    const body = '<p>{{person.full_name}}</p>';
    const data = { person: { full_name: 'Jane & Co <Ltd>' } };
    const once = renderMerge(body, data).html;
    expect(renderMerge(once, data).html).toBe(once);
  });
});

describe('escapeHtml', () => {
  it('escapes all five entities', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so entities are not double-escaped wrongly', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('mergeTemplate — validate then render, inseparably', () => {
  it('returns the parsed bag alongside the html', () => {
    const result = mergeTemplate('<p>{{person.full_name}}</p>', ['person'], {
      person: { full_name: 'Jane Doe', first_name: null, last_name: null, email: null },
    });
    expect(result.html).toBe('<p>Jane Doe</p>');
    expect(result.mergeData.person.full_name).toBe('Jane Doe');
    expect(result.blanks).toEqual([]);
  });

  it('refuses to render an invalid bag at all', () => {
    expect(() => mergeTemplate('<p>{{person.full_name}}</p>', ['person'], {})).toThrow(
      MergeDataError,
    );
  });
});

// Keep the registry clean for any suite that runs after this file in-process.
// In `afterAll`, not at module scope: a module body runs before any test does,
// so a bare call here would unregister the context the tests are about to use.
afterAll(() => unregisterMergeContextForTests('widget'));
