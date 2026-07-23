/**
 * `@repo/domain` — the pure business-logic home (ADR-0009). Every export is a
 * deterministic function of its arguments: no I/O, no database, no environment,
 * no clock or randomness (see CLAUDE.md). Engines are re-exported here.
 */
export { isWithinPeriod, overlaps } from './lib/period.js';
export {
  defineEvent,
  EVENT_TYPE_PATTERN,
  eventTypes,
  eventDefinition,
  isEventType,
  platformDemoPinged,
  type EventDefinition,
  type EventType,
  type EventPayload,
} from './events/index.js';
