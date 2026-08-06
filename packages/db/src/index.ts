import type { Insertable, Selectable, Updateable } from 'kysely';
import type {
  Account,
  PlatformConfigEntry,
  PlatformDomainEvent,
  PlatformEventConsumption,
  PlatformLookup,
  PlatformPerson,
  PlatformPersonAllocation,
  PlatformPersonFlag,
  PlatformPersonMerge,
  PlatformRole,
  PlatformRoleGrant,
  PlatformScheduledAction,
  PlatformTeam,
  PlatformTeamMembership,
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
  PlatformConfigEntry,
  PlatformDomainEvent,
  PlatformEventConsumption,
  PlatformLookup,
  PlatformPerson,
  PlatformPersonAllocation,
  PlatformPersonFlag,
  PlatformPersonMerge,
  PlatformRole,
  PlatformRoleGrant,
  PlatformScheduledAction,
  PlatformTeam,
  PlatformTeamMembership,
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
