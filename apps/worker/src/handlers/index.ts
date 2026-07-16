import type { HandlerRegistration } from '../types.js';
import { helloWorldHandler } from './hello-world.js';

/** Barrel of all handler registrations. Add new handlers here. */
export const handlers: HandlerRegistration[] = [
  { queue: 'hello-world', handler: helloWorldHandler },
];
