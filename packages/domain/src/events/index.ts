/** Event-type registry (core plan 02 §4.2). Re-exported from the package root. */
export { defineEvent, EVENT_TYPE_PATTERN, type EventDefinition } from './define.js';
export {
  eventTypes,
  eventDefinition,
  isEventType,
  type EventType,
  type EventPayload,
} from './registry.js';
export {
  platformDemoPinged,
  workflowTransitionedPayload,
  // Shared calendar & Outlook sync (core plan 12) — the worker's handler and the
  // pilot procedure both name these definitions rather than the string types.
  platformCalendarOutlookEventCancelled,
  platformCalendarOutlookEventCreated,
  platformCalendarOutlookEventUpdated,
  platformCalendarOutlookSyncFailed,
  platformDemoCalendarItemApproved,
  platformDemoCalendarItemCancelled,
  platformDemoCalendarItemRescheduled,
} from './platform.js';
