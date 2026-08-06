/**
 * `@repo/config` — the configuration store's code-side half (core plan 06
 * §4.6/§4.7, ADR-0016): the key registry that makes a `jsonb` value column
 * safe, and the as-at resolution and single write path over
 * `platform.config_entry`.
 *
 * **Import the registry through this barrel, never `./registry.js` directly.**
 * Keys register as a side effect of loading their definition module, so this
 * file's re-export of `./keys.js` is what guarantees a populated registry for
 * every consumer.
 *
 * ### Why this is its own package
 *
 * It shipped inside `@repo/trpc` (plan 06 §12.2 Q1) because that is where the
 * shared Zod schemas live. Core plan 07 forced the move: the workflow runtime
 * lives in `@repo/workflow`, which `@repo/trpc` imports for its
 * `platform.workflow.*` router — and the runtime must resolve `config:`
 * references as-at transition time, so it needs this. Leaving it in `@repo/trpc`
 * made the two packages mutually dependent, with a module whose side effect is
 * populating a registry sitting inside the cycle.
 *
 * **`@repo/trpc` re-exports everything below**, so `import { getConfig } from
 * '@repo/trpc'` still works, the admin editor still renders and validates from
 * the very same schemas the write path enforces, and no call site changed.
 *
 * `@repo/domain` was rejected as a home for the same reason plan 06 rejected it:
 * pure guards receive resolved config **values** as parameters and must never
 * know where they came from (ADR-0009/0013). This package does I/O; that one
 * must not.
 */
export {
  configRegistry,
  defineConfigKey,
  qualifiedName,
  requireConfigKey,
  unregisterConfigKeyForTests,
  ConfigKeyUnknownError,
  ConfigValueInvalidError,
  type ConfigKeyDef,
} from './registry.js';

export {
  getConfig,
  parseConfigRef,
  resolveConfig,
  resetConfig,
  setConfig,
  ConfigEffectiveFromError,
  ConfigWriteConflictError,
  type ResolvedConfig,
  type ResetConfigArgs,
  type SetConfigArgs,
  type SetConfigResult,
} from './resolve.js';

export {
  approvalSubjectTypes,
  defineApprovalSubject,
  isApprovalSubject,
  requireApprovalSubject,
  unregisterApprovalSubjectForTests,
  ApprovalSubjectUnknownError,
  type ApprovalSubjectDef,
  type DefineApprovalSubjectInput,
} from './approval-subjects.js';

export * from './keys.js';
