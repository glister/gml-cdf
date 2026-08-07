// Side-effect import: loading `@repo/trpc` registers the `tasks.*` (core plan
// 08 §9.6) and `approval.*` (core plan 09 §5.5) effect handlers, the pilot
// subject loaders and the pilot warning provider in `@repo/workflow`'s
// registries. Without it the effects consumer below would dead-letter every
// `tasks.raiseList` and `approval.open` message as an unknown effect — each
// registry is populated by its owning plan's module, and someone has to load
// them in this process. One import covers every engine, which is the point of
// registering through the package barrel.
import '@repo/trpc';
import type { HandlerRegistration } from '../types.js';
import { effectsHandler } from './effects.js';
import { helloWorldHandler } from './hello-world.js';
import { pilotDemoHandler } from './pilot-demo.js';

/** Barrel of all handler registrations. Add new handlers here. */
export const handlers: HandlerRegistration[] = [
  { queue: 'hello-world', handler: helloWorldHandler },
  // Pilot consumer of the domain-event journal relay (core plan 02 §5.2).
  { queue: 'domain-events', subscription: 'pilot-demo', handler: pilotDemoHandler },
  // Scheduled identity sweeps — dispatched by message subject (core plan 03 §5.2).
  { queue: 'effects', handler: effectsHandler },
];
