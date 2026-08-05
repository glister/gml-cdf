/**
 * The configuration store's code-side half (core plan 06 §4.6/§4.7).
 *
 * **Import the registry through this barrel, never `./registry.js` directly.**
 * Keys register as a side effect of loading their definition module, so this
 * file's re-export of `./keys.js` is what guarantees a populated registry for
 * every consumer — `@repo/trpc`'s package index re-exports this in turn.
 */
export {
  configRegistry,
  defineConfigKey,
  qualifiedName,
  requireConfigKey,
  ConfigKeyUnknownError,
  ConfigValueInvalidError,
  type ConfigKeyDef,
} from './registry.js';

export * from './keys.js';
