import type { z } from 'zod';
import type { EventDefinition } from './define.js';
import {
  platformApprovalDelegationCreated,
  platformApprovalDelegationRevoked,
  platformApprovalRequestApproved,
  platformApprovalRequestAutoApproved,
  platformApprovalRequestCancelled,
  platformApprovalRequestRejected,
  platformApprovalRequestRequested,
  platformConfigEntryChanged,
  platformConfigEntryReset,
  platformDataSpecialCategoryAccessed,
  platformDemoPinged,
  platformDocumentCancelled,
  platformDocumentCompleted,
  platformCalendarOutlookEventCancelled,
  platformCalendarOutlookEventCreated,
  platformCalendarOutlookEventUpdated,
  platformCalendarOutlookSyncFailed,
  platformDemoCalendarItemApproved,
  platformDemoCalendarItemCancelled,
  platformDemoCalendarItemRescheduled,
  platformDocumentContentAccessed,
  platformDocumentEvidenceExported,
  platformDocumentFiled,
  platformDocumentFilingFailed,
  platformDocumentGenerated,
  platformDocumentIssued,
  platformDocumentSigned,
  platformDocumentViewed,
  platformLookupValueCreated,
  platformLookupValueDeactivated,
  platformLookupValueDeleted,
  platformLookupValueReactivated,
  platformLookupValueUpdated,
  platformNotificationDeliveryFailed,
  platformNotificationRequested,
  platformNotificationSent,
  platformNotificationUnresolved,
  platformPersonAccessExpired,
  platformPersonAccessExpirySet,
  platformPersonAllocationAdded,
  platformPersonAllocationEnded,
  platformPersonCreated,
  platformPersonCredentialLinked,
  platformPersonDuplicateDismissed,
  platformPersonDuplicateFlagged,
  platformPersonFlagAdded,
  platformPersonFlagEnded,
  platformPersonInvited,
  platformPersonMerged,
  platformPersonMergeReversed,
  platformPersonPrecreationCheckOverridden,
  platformPersonProfileStatusChanged,
  platformPersonReengaged,
  platformPersonRelationshipChanged,
  platformPersonSignedIn,
  platformReminderChased,
  platformReminderCompleted,
  platformRoleGranted,
  platformRoleRevoked,
  platformScheduledActionCancelled,
  platformScheduledActionRescheduled,
  platformScheduledActionScheduled,
  platformTemplateArchived,
  platformTemplatePublished,
  platformTaskCancelled,
  platformTaskClaimed,
  platformTaskCompleted,
  platformTaskDueRecomputed,
  platformTaskGateOpened,
  platformTaskRaised,
  platformTaskReleased,
  platformTaskUnblocked,
  platformTeamArchived,
  platformTeamCreated,
  platformTeamMembershipAdded,
  platformTeamMembershipCorrected,
  platformTeamMembershipEnded,
  platformTeamUpdated,
  platformWorkflowInstanceDemoOutcomeRecorded,
  platformWorkflowInstanceStarted,
  platformWorkflowInstanceTransitioned,
} from './platform.js';

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
  // Identity & person model (core plan 03, PL-045).
  'platform.person.created': platformPersonCreated,
  'platform.person.invited': platformPersonInvited,
  'platform.person.credential_linked': platformPersonCredentialLinked,
  'platform.person.signed_in': platformPersonSignedIn,
  'platform.person.duplicate_flagged': platformPersonDuplicateFlagged,
  'platform.person.duplicate_dismissed': platformPersonDuplicateDismissed,
  'platform.person.merged': platformPersonMerged,
  'platform.person.merge_reversed': platformPersonMergeReversed,
  'platform.person.flag_added': platformPersonFlagAdded,
  'platform.person.flag_ended': platformPersonFlagEnded,
  'platform.person.access_expiry_set': platformPersonAccessExpirySet,
  'platform.person.access_expired': platformPersonAccessExpired,
  'platform.person.reengaged': platformPersonReengaged,
  'platform.person.profile_status_changed': platformPersonProfileStatusChanged,
  'platform.person.relationship_changed': platformPersonRelationshipChanged,
  'platform.person.precreation_check_overridden': platformPersonPrecreationCheckOverridden,
  // Authorisation — role, record and field level (core plan 04, PL-002/003).
  'platform.role.granted': platformRoleGranted,
  'platform.role.revoked': platformRoleRevoked,
  'platform.data.special_category.accessed': platformDataSpecialCategoryAccessed,
  'platform.person.allocation_added': platformPersonAllocationAdded,
  'platform.person.allocation_ended': platformPersonAllocationEnded,
  // Reference-data service (core plan 05, PL-005/006/007, kind='admin').
  'platform.lookup.value.created': platformLookupValueCreated,
  'platform.lookup.value.updated': platformLookupValueUpdated,
  'platform.lookup.value.deactivated': platformLookupValueDeactivated,
  'platform.lookup.value.reactivated': platformLookupValueReactivated,
  'platform.lookup.value.deleted': platformLookupValueDeleted,
  'platform.team.created': platformTeamCreated,
  'platform.team.updated': platformTeamUpdated,
  'platform.team.archived': platformTeamArchived,
  'platform.team.membership.added': platformTeamMembershipAdded,
  'platform.team.membership.ended': platformTeamMembershipEnded,
  'platform.team.membership.corrected': platformTeamMembershipCorrected,
  // Configuration store (core plan 06, PL-029/030, kind='admin').
  'platform.config_entry.changed': platformConfigEntryChanged,
  'platform.config_entry.reset': platformConfigEntryReset,
  // Workflow runtime & scheduled actions (core plan 07, ADR-0013).
  'platform.workflow_instance.started': platformWorkflowInstanceStarted,
  'platform.workflow_instance.transitioned': platformWorkflowInstanceTransitioned,
  'platform.workflow_instance.demo_outcome_recorded': platformWorkflowInstanceDemoOutcomeRecorded,
  'platform.scheduled_action.scheduled': platformScheduledActionScheduled,
  'platform.scheduled_action.rescheduled': platformScheduledActionRescheduled,
  'platform.scheduled_action.cancelled': platformScheduledActionCancelled,
  // Task & checklist engine (core plan 08, PL-013…015).
  'platform.task.raised': platformTaskRaised,
  'platform.task.unblocked': platformTaskUnblocked,
  'platform.task.claimed': platformTaskClaimed,
  'platform.task.released': platformTaskReleased,
  'platform.task.completed': platformTaskCompleted,
  'platform.task.cancelled': platformTaskCancelled,
  'platform.task.due_recomputed': platformTaskDueRecomputed,
  'platform.task.gate.opened': platformTaskGateOpened,
  // Approval engine (core plan 09, PL-016…018). Streamed on the request row per
  // ADR-0021; `auto_approved` is the documented exception (no row exists).
  'platform.approval_request.requested': platformApprovalRequestRequested,
  'platform.approval_request.approved': platformApprovalRequestApproved,
  'platform.approval_request.rejected': platformApprovalRequestRejected,
  'platform.approval_request.cancelled': platformApprovalRequestCancelled,
  'platform.approval_request.auto_approved': platformApprovalRequestAutoApproved,
  'platform.approval_delegation.created': platformApprovalDelegationCreated,
  'platform.approval_delegation.revoked': platformApprovalDelegationRevoked,
  // Notifications & reminders (core plan 10, PL-019…021). The four
  // `platform.notification.*` facts stream on the notification row per
  // ADR-0021. The two `platform.reminder.*` facts are the documented exception:
  // a reminder *series* has no row of its own — each occurrence is a
  // `scheduled_action` — so they stream on the **source** being chased, which
  // is also where anyone asking "was this chased, and did it stop?" looks.
  'platform.notification.requested': platformNotificationRequested,
  'platform.notification.sent': platformNotificationSent,
  'platform.notification.delivery_failed': platformNotificationDeliveryFailed,
  'platform.notification.unresolved': platformNotificationUnresolved,
  'platform.reminder.chased': platformReminderChased,
  'platform.reminder.completed': platformReminderCompleted,
  // Documents, templates & e-signature (core plan 11, PL-009…012). Template
  // facts stream on the template row and document facts on the document row
  // (ADR-0021); the subject person travels as a payload field, so audit and
  // reporting can still fan out by it. `evidence_exported` and
  // `content_accessed` are `kind='security'` (ADR-0015) — the second is the
  // document domain's restricted-category read, deliberately NOT a second
  // special-category event name (plan 04 owns that one).
  'platform.template.published': platformTemplatePublished,
  'platform.template.archived': platformTemplateArchived,
  'platform.document.generated': platformDocumentGenerated,
  'platform.document.issued': platformDocumentIssued,
  'platform.document.viewed': platformDocumentViewed,
  'platform.document.signed': platformDocumentSigned,
  'platform.document.completed': platformDocumentCompleted,
  'platform.document.filed': platformDocumentFiled,
  'platform.document.filing_failed': platformDocumentFilingFailed,
  'platform.document.cancelled': platformDocumentCancelled,
  'platform.document.evidence_exported': platformDocumentEvidenceExported,
  'platform.document.content_accessed': platformDocumentContentAccessed,
  // Shared calendar & Outlook sync (core plan 12, PL-024). The entity is
  // `calendar_sync_state` — the only durable row involved — not the `calendar`
  // the plan's §4.3 sketched, which is a read model with no table (ADR-0021).
  // The demo trio streams on `platform.demo`, whose events ARE the pilot
  // source's state: it has no table on purpose.
  'platform.calendar_sync_state.outlook_event_created': platformCalendarOutlookEventCreated,
  'platform.calendar_sync_state.outlook_event_updated': platformCalendarOutlookEventUpdated,
  'platform.calendar_sync_state.outlook_event_cancelled': platformCalendarOutlookEventCancelled,
  'platform.calendar_sync_state.outlook_sync_failed': platformCalendarOutlookSyncFailed,
  'platform.demo.calendar_item_approved': platformDemoCalendarItemApproved,
  'platform.demo.calendar_item_rescheduled': platformDemoCalendarItemRescheduled,
  'platform.demo.calendar_item_cancelled': platformDemoCalendarItemCancelled,
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
