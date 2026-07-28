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
