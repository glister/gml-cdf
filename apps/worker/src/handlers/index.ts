// Side-effect import: loading `@repo/trpc` registers the `tasks.*` effect
// handlers and the pilot subject loader in `@repo/workflow`'s registries (core
// plan 08 §9.6). Without it the effects consumer below would dead-letter every
// `tasks.raiseList` message as an unknown effect — the registry is populated by
// the owning plan's module, and someone has to load it in this process.
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
