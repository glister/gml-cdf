import type { Insertable, Selectable, Updateable } from 'kysely';
import type {
  Account,
  PlatformDomainEvent,
  PlatformEventConsumption,
  PlatformPerson,
  PlatformPersonAllocation,
  PlatformPersonFlag,
  PlatformPersonMerge,
  PlatformRole,
  PlatformRoleGrant,
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
  grantRole,
  revokeGrant,
  revokeAllGrantsForPerson,
  type GrantRoleInput,
  type RevokeGrantInput,
  type RevokedGrantSummary,
} from './authz.js';
export type { DB } from './types.js';
export type {
  Account,
  PlatformDomainEvent,
  PlatformEventConsumption,
  PlatformPerson,
  PlatformPersonAllocation,
  PlatformPersonFlag,
  PlatformPersonMerge,
  PlatformRole,
  PlatformRoleGrant,
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
