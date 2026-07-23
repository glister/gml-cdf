/** Event-type registry (core plan 02 §4.2). Re-exported from the package root. */
export { defineEvent, EVENT_TYPE_PATTERN, type EventDefinition } from './define.js';
export {
  eventTypes,
  eventDefinition,
  isEventType,
  type EventType,
  type EventPayload,
} from './registry.js';
export { platformDemoPinged } from './platform.js';
