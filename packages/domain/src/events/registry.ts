import type { z } from 'zod';
import type { EventDefinition } from './define.js';
import { platformDemoPinged } from './platform.js';

/**
 * The registry of every event type the platform can emit — the single source for
 * both runtime validation (`eventDefinition`) and the static `EventType` /
 * `EventPayload<T>` types. Later plans add their module's definitions here with
 * a literal key equal to the definition's `type` (asserted by a registry test):
 *
 *   'platform.person.merged': platformPersonMerged,
 *
 * Written as literal keys (not computed) so `keyof typeof eventTypes` is the
 * exact union of registered names.
 */
export const eventTypes = {
  'platform.demo.pinged': platformDemoPinged,
} as const;

/** The union of all registered event-type names. */
export type EventType = keyof typeof eventTypes;

/** The payload type for a given event type, inferred from its Zod schema. */
export type EventPayload<T extends EventType> = z.infer<(typeof eventTypes)[T]['payloadSchema']>;

/** Runtime type guard: is `type` a registered event type? */
export function isEventType(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(eventTypes, type);
}

/**
 * Look up a definition by name at runtime. Returns `undefined` for an
 * unregistered type — `appendEvent` turns that into a throw before insert.
 */
export function eventDefinition(type: string): EventDefinition | undefined {
  return isEventType(type) ? eventTypes[type] : undefined;
}
