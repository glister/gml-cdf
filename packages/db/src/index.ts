import type { Insertable, Selectable, Updateable } from 'kysely';
import type {
  Account,
  PlatformApprovalAssignee,
  PlatformApprovalDecision,
  PlatformApprovalDelegation,
  PlatformApprovalRequest,
  PlatformCalendarSyncState,
  PlatformConfigEntry,
  PlatformDocument,
  PlatformDomainEvent,
  PlatformEventConsumption,
  PlatformLookup,
  PlatformNotification,
  PlatformNotificationDelivery,
  PlatformPerson,
  PlatformPersonAllocation,
  PlatformPersonFlag,
  PlatformPersonMerge,
  PlatformRole,
  PlatformRoleGrant,
  PlatformScheduledAction,
  PlatformSignatureEvidence,
  PlatformTask,
  PlatformTaskDependency,
  PlatformTeam,
  PlatformTeamMembership,
  PlatformTemplate,
  PlatformWorkflowInstance,
  PlatformWorkflowTransition,
  Session,
  User,
  Verification,
} from './types.js';

export { db, pool } from './client.js';
export { newUuidV7 } from './ids.js';
export {
  appendEvent,
  payloadByteSize,
  MAX_PAYLOAD_BYTES,
  type AppendEventInput,
} from './journal.js';
export { relayOutboxBatch, recordConsumptionOnce } from './outbox.js';
export {
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from './pg-errors.js';
export { makeSnapshot, type SnapshotEnvelope, type MakeSnapshotArgs } from './lib/snapshot.js';
export {
  activeOn,
  endEffective,
  type EffectiveDatedTable,
  type EndEffectiveInput,
} from './lib/effective-dating.js';
export {
  grantRole,
  loadGrantsForPerson,
  revokeGrant,
  revokeAllGrantsForPerson,
  type GrantRoleInput,
  type RevokeGrantInput,
  type RevokedGrantSummary,
} from './authz.js';
export type { DB } from './types.js';
/**
 * The generated jsonb/timestamp aliases. Re-exported because a router selecting
 * a `jsonb` column would otherwise infer a type that can only be named through
 * `@repo/db/src/types.js` — a deep path TypeScript rightly calls unportable
 * (TS2742). Naming them here keeps consumers on the package's public surface.
 */
export type { Json, JsonArray, JsonObject, JsonPrimitive, JsonValue, Timestamp } from './types.js';
export type {
  Account,
  PlatformApprovalAssignee,
  PlatformApprovalDecision,
  PlatformApprovalDelegation,
  PlatformApprovalRequest,
  PlatformCalendarSyncState,
  PlatformConfigEntry,
  PlatformDocument,
  PlatformDomainEvent,
  PlatformEventConsumption,
  PlatformLookup,
  PlatformNotification,
  PlatformNotificationDelivery,
  PlatformPerson,
  PlatformPersonAllocation,
  PlatformPersonFlag,
  PlatformPersonMerge,
  PlatformRole,
  PlatformRoleGrant,
  PlatformScheduledAction,
  PlatformSignatureEvidence,
  PlatformTask,
  PlatformTaskDependency,
  PlatformTeam,
  PlatformTeamMembership,
  PlatformTemplate,
  PlatformWorkflowInstance,
  PlatformWorkflowTransition,
  Session,
  User,
  Verification,
} from './types.js';

// Selectable/Insertable/Updateable wrappers — use these instead of inline
// anonymous record types.
export type UserRecord = Selectable<User>;
export type NewUser = Insertable<User>;
export type UserUpdate = Updateable<User>;

export type SessionRecord = Selectable<Session>;
export type NewSession = Insertable<Session>;
export type SessionUpdate = Updateable<Session>;

export type AccountRecord = Selectable<Account>;
export type NewAccount = Insertable<Account>;
export type AccountUpdate = Updateable<Account>;

export type VerificationRecord = Selectable<Verification>;
export type NewVerification = Insertable<Verification>;
export type VerificationUpdate = Updateable<Verification>;

// Event journal & outbox (core plan 02, ADR-0010).
export type DomainEventRecord = Selectable<PlatformDomainEvent>;
export type NewDomainEvent = Insertable<PlatformDomainEvent>;
export type DomainEventUpdate = Updateable<PlatformDomainEvent>;

export type EventConsumptionRecord = Selectable<PlatformEventConsumption>;
export type NewEventConsumption = Insertable<PlatformEventConsumption>;

// Identity & person model (core plan 03, ADR-0014).
export type PersonRecord = Selectable<PlatformPerson>;
export type NewPerson = Insertable<PlatformPerson>;
export type PersonUpdate = Updateable<PlatformPerson>;

export type PersonMergeRecord = Selectable<PlatformPersonMerge>;
export type NewPersonMerge = Insertable<PlatformPersonMerge>;
export type PersonMergeUpdate = Updateable<PlatformPersonMerge>;

export type PersonFlagRecord = Selectable<PlatformPersonFlag>;
export type NewPersonFlag = Insertable<PlatformPersonFlag>;
export type PersonFlagUpdate = Updateable<PlatformPersonFlag>;

// Authorisation — role, record and field level (core plan 04, ADR-0015).
export type RoleRecord = Selectable<PlatformRole>;
export type NewRole = Insertable<PlatformRole>;
export type RoleUpdate = Updateable<PlatformRole>;

export type RoleGrantRecord = Selectable<PlatformRoleGrant>;
export type NewRoleGrant = Insertable<PlatformRoleGrant>;
export type RoleGrantUpdate = Updateable<PlatformRoleGrant>;

export type PersonAllocationRecord = Selectable<PlatformPersonAllocation>;
export type NewPersonAllocation = Insertable<PlatformPersonAllocation>;
export type PersonAllocationUpdate = Updateable<PlatformPersonAllocation>;

// Reference-data service (core plan 05, ADR-0016).
export type LookupRecord = Selectable<PlatformLookup>;
export type NewLookup = Insertable<PlatformLookup>;
export type LookupUpdate = Updateable<PlatformLookup>;

export type TeamRecord = Selectable<PlatformTeam>;
export type NewTeam = Insertable<PlatformTeam>;
export type TeamUpdate = Updateable<PlatformTeam>;

export type TeamMembershipRecord = Selectable<PlatformTeamMembership>;
export type NewTeamMembership = Insertable<PlatformTeamMembership>;
export type TeamMembershipUpdate = Updateable<PlatformTeamMembership>;

// Configuration store (core plan 06, ADR-0016). `ConfigEntryUpdate` covers only
// the supersede stamp — the close-only guard rejects every other UPDATE.
export type ConfigEntryRecord = Selectable<PlatformConfigEntry>;
export type NewConfigEntry = Insertable<PlatformConfigEntry>;
export type ConfigEntryUpdate = Updateable<PlatformConfigEntry>;

// Workflow runtime & scheduled actions (core plan 07, ADR-0013). There is no
// `WorkflowTransitionUpdate`: the transition log is append-only at the database
// level, so a row is only ever inserted (ADR-0011).
export type WorkflowInstanceRecord = Selectable<PlatformWorkflowInstance>;
export type NewWorkflowInstance = Insertable<PlatformWorkflowInstance>;
export type WorkflowInstanceUpdate = Updateable<PlatformWorkflowInstance>;

export type WorkflowTransitionRecord = Selectable<PlatformWorkflowTransition>;
export type NewWorkflowTransition = Insertable<PlatformWorkflowTransition>;

export type ScheduledActionRecord = Selectable<PlatformScheduledAction>;
export type NewScheduledAction = Insertable<PlatformScheduledAction>;
export type ScheduledActionUpdate = Updateable<PlatformScheduledAction>;

// Task & checklist engine (core plan 08, PL-013…015). Both tables are mutable
// process state (ADR-0012): `task_dependency` rows are satisfied in place, so
// they carry an `Updateable` alias even though a row is never deleted.
export type TaskRecord = Selectable<PlatformTask>;
export type NewTask = Insertable<PlatformTask>;
export type TaskUpdate = Updateable<PlatformTask>;

export type TaskDependencyRecord = Selectable<PlatformTaskDependency>;
export type NewTaskDependency = Insertable<PlatformTaskDependency>;
export type TaskDependencyUpdate = Updateable<PlatformTaskDependency>;

// Approval engine (core plan 09, PL-016…018). `approval_decision` is
// append-only (ADR-0011) and so has no `Updateable` alias — the absence is the
// point: there is no code path that could name the type of an edit to a
// decision, because there is no such operation.
export type ApprovalRequestRecord = Selectable<PlatformApprovalRequest>;
export type NewApprovalRequest = Insertable<PlatformApprovalRequest>;
export type ApprovalRequestUpdate = Updateable<PlatformApprovalRequest>;

export type ApprovalAssigneeRecord = Selectable<PlatformApprovalAssignee>;
export type NewApprovalAssignee = Insertable<PlatformApprovalAssignee>;
export type ApprovalAssigneeUpdate = Updateable<PlatformApprovalAssignee>;

export type ApprovalDecisionRecord = Selectable<PlatformApprovalDecision>;
export type NewApprovalDecision = Insertable<PlatformApprovalDecision>;

export type ApprovalDelegationRecord = Selectable<PlatformApprovalDelegation>;
export type NewApprovalDelegation = Insertable<PlatformApprovalDelegation>;
export type ApprovalDelegationUpdate = Updateable<PlatformApprovalDelegation>;

// Notifications & reminders (core plan 10, PL-019…021). Both tables are
// operational state, so both carry the full trio: a delivery that could not be
// updated could not record its own retry.
export type NotificationRecord = Selectable<PlatformNotification>;
export type NewNotification = Insertable<PlatformNotification>;
export type NotificationUpdate = Updateable<PlatformNotification>;

export type NotificationDeliveryRecord = Selectable<PlatformNotificationDelivery>;
export type NewNotificationDelivery = Insertable<PlatformNotificationDelivery>;
export type NotificationDeliveryUpdate = Updateable<PlatformNotificationDelivery>;

// Documents, templates & e-signature (core plan 11, PL-009…012). `template` is a
// versioned snapshot class and `document` operational state — both mutable in
// their permitted directions and both guarded by triggers. `signature_evidence`
// has no `Updateable`: the table is append-only at the database level, so a type
// permitting an update would describe an operation Postgres refuses.
export type TemplateRecord = Selectable<PlatformTemplate>;
export type NewTemplate = Insertable<PlatformTemplate>;
export type TemplateUpdate = Updateable<PlatformTemplate>;

export type DocumentRecord = Selectable<PlatformDocument>;
export type NewDocument = Insertable<PlatformDocument>;
export type DocumentUpdate = Updateable<PlatformDocument>;

export type SignatureEvidenceRecord = Selectable<PlatformSignatureEvidence>;
export type NewSignatureEvidence = Insertable<PlatformSignatureEvidence>;

// Shared calendar & Outlook sync (core plan 12, PL-024). Operational state, so
// all three wrappers apply: the row is created pending, updated as Graph
// answers, and never deleted.
export type CalendarSyncStateRecord = Selectable<PlatformCalendarSyncState>;
export type NewCalendarSyncState = Insertable<PlatformCalendarSyncState>;
export type CalendarSyncStateUpdate = Updateable<PlatformCalendarSyncState>;
