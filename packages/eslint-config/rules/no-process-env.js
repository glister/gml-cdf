/**
 * Custom ESLint rule: forbid direct `process.env` access.
 *
 * The env boundary is `@repo/env` — every package/app defines a local Zod schema
 * and reads config through `parse()` / `safeParse()`. Direct `process.env` access
 * bypasses validation and typing, so it is disallowed everywhere.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct process.env access; use parse()/safeParse() from @repo/env instead.',
    },
    schema: [],
    messages: {
      noProcessEnv:
        'Do not access process.env directly. Define a Zod schema and read config via parse()/safeParse() from @repo/env.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const { object } = node;
        if (
          object &&
          object.type === 'Identifier' &&
          object.name === 'process' &&
          node.property &&
          ((node.property.type === 'Identifier' && node.property.name === 'env') ||
            (node.property.type === 'Literal' && node.property.value === 'env'))
        ) {
          context.report({ node, messageId: 'noProcessEnv' });
        }
      },
    };
  },
};

export default rule;
