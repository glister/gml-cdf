/**
 * `@repo/domain` — the pure business-logic home (ADR-0009). Every export is a
 * deterministic function of its arguments: no I/O, no database, no environment,
 * no clock or randomness (see CLAUDE.md). Engines are re-exported here.
 */
export { isWithinPeriod, overlaps } from './lib/period.js';
export {
  activeModulesFor,
  grantState,
  hasRole,
  isGrantActive,
  type Grant,
  type GrantState,
} from './authz/grants.js';
export { MODULE_KEYS, ROLE_KEYS, type ModuleKey, type RoleKey } from './authz/roles.js';
export {
  matchDuplicate,
  normaliseIdentityValue,
  type DuplicateMatchReason,
  type DuplicateMatchResult,
  type PersonIdentityAttributes,
} from './identity/duplicate-match.js';
export {
  planFlagUnion,
  type ActiveFlag,
  type FlagCopyPlan,
  type PersonFlagType,
} from './identity/flag-union.js';
export {
  allowedTransitions,
  canTransition,
  type ProfileStatus,
} from './identity/profile-status.js';
export {
  defineEvent,
  EVENT_TYPE_PATTERN,
  eventTypes,
  eventDefinition,
  isEventType,
  platformDemoPinged,
  workflowTransitionedPayload,
  // Shared calendar & Outlook sync (core plan 12) — the worker's handler and the
  // pilot procedure name these definitions rather than the string types.
  platformCalendarOutlookEventCancelled,
  platformCalendarOutlookEventCreated,
  platformCalendarOutlookEventUpdated,
  platformCalendarOutlookSyncFailed,
  platformDemoCalendarItemApproved,
  platformDemoCalendarItemCancelled,
  platformDemoCalendarItemRescheduled,
  type EventDefinition,
  type EventType,
  type EventPayload,
} from './events/index.js';
export {
  addCalendarDays,
  parseCalendarDate,
  parseTimeOfDay,
  wallClockIn,
  zonedInstant,
  zoneOffsetMs,
  ZonedTimeError,
  type WallClock,
} from './lib/zoned-time.js';
export * from './workflow/index.js';
export * from './tasks/index.js';
export * from './approvals/index.js';
export * from './notifications/index.js';
export * from './documents/index.js';
export * from './calendar/index.js';
