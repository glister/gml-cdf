import type { Insertable, Selectable, Updateable } from 'kysely';
import type {
  Account,
  PlatformDomainEvent,
  PlatformEventConsumption,
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
export type { DB } from './types.js';
export type {
  Account,
  PlatformDomainEvent,
  PlatformEventConsumption,
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
