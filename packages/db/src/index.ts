import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Account, Session, User, Verification } from './types.js';

export { db, pool } from './client.js';
export type { DB } from './types.js';
export type { Account, Session, User, Verification } from './types.js';

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
