import { z } from 'zod';
import {
  FIELD_CLASSES,
  GRANT_STATES,
  MODULE_KEYS,
  PERSON_FLAG_TYPES,
  PERSON_SORTS,
  PERSON_STATUSES,
  PROFILE_STATUSES,
  RELATIONSHIP_TYPES,
  ROLE_KEYS,
  SORT_DIRECTIONS,
  USER_ROLES,
} from './lib/constants.js';

/**
 * Flat module of Zod input/output schemas + inferred types. Enums are derived
 * from the constant tuples in `./lib/constants.ts`. Every router pulls its
 * validators from here.
 */

export const sortDirEnum = z.enum(SORT_DIRECTIONS);
export type SortDir = z.infer<typeof sortDirEnum>;

export const userRoleEnum = z.enum(USER_ROLES);
export type UserRoleInput = z.infer<typeof userRoleEnum>;

/** Base cursor-pagination input shared by every keyset-paginated list. */
export const cursorPaginationInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  sortDir: sortDirEnum.default('desc'),
});
export type CursorPaginationInput = z.infer<typeof cursorPaginationInput>;

export const byIdInput = z.object({ id: z.string().min(1) });
export type ByIdInput = z.infer<typeof byIdInput>;

// --- users router ---

export const listUsersInput = cursorPaginationInput.extend({
  search: z.string().trim().min(1).optional(),
  role: userRoleEnum.optional(),
});
export type ListUsersInput = z.infer<typeof listUsersInput>;

export const updateUserRoleInput = z.object({
  id: z.string().min(1),
  role: userRoleEnum,
});
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleInput>;

export const userListItem = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: userRoleEnum,
  banned: z.boolean(),
  created_at: z.union([z.string(), z.date()]),
});
export type UserListItem = z.infer<typeof userListItem>;

// --- platform.journal router (core plan 02 pilot slice) ---

export const demoPingInput = z.object({ note: z.string().max(200) });
export type DemoPingInput = z.infer<typeof demoPingInput>;

export const demoPingOutput = z.object({ eventId: z.uuid() });
export type DemoPingOutput = z.infer<typeof demoPingOutput>;

// --- platform.identity router (core plan 03 §5.1) ---

export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export type RelationshipTypeInput = z.infer<typeof relationshipTypeSchema>;
export const profileStatusSchema = z.enum(PROFILE_STATUSES);
export type ProfileStatusInput = z.infer<typeof profileStatusSchema>;
export const personStatusSchema = z.enum(PERSON_STATUSES);
export const personFlagTypeSchema = z.enum(PERSON_FLAG_TYPES);

/** Free-text audit rationale required by state-changing identity actions. */
const reasonSchema = z.string().trim().min(1).max(2000);

export const listPersonsInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  relationshipType: relationshipTypeSchema.optional(),
  profileStatus: profileStatusSchema.optional(),
  status: personStatusSchema.optional(),
  search: z.string().trim().max(200).optional(),
  expiringWithinDays: z.number().int().positive().optional(),
  sort: z.enum(PERSON_SORTS).default('created_at'),
  sortDir: z.enum(SORT_DIRECTIONS).default('desc'),
});
export type ListPersonsInput = z.infer<typeof listPersonsInput>;

export const personIdInput = z.object({ personId: z.uuid() });

export const updatePersonInput = z.object({
  personId: z.uuid(),
  displayName: z.string().trim().min(1).max(400).optional(),
  givenName: z.string().trim().max(200).nullish(),
  familyName: z.string().trim().max(200).nullish(),
  dateOfBirth: z.iso.date().nullish(),
  contactEmail: z.string().trim().max(320).nullish(),
  agencyWorkerReference: z.string().trim().max(100).nullish(),
});
export type UpdatePersonInput = z.infer<typeof updatePersonInput>;

export const mergePersonsInput = z.object({
  survivingPersonId: z.uuid(),
  supersededPersonId: z.uuid(),
  reason: reasonSchema,
});
export const unmergeInput = z.object({ mergeId: z.uuid(), reason: reasonSchema });

export const addFlagInput = z.object({
  personId: z.uuid(),
  flagType: personFlagTypeSchema,
  reason: reasonSchema,
});
export const endFlagInput = z.object({ flagId: z.uuid(), reason: reasonSchema });

export const setAccessValidUntilInput = z.object({
  personId: z.uuid(),
  accessValidUntil: z.iso.datetime(),
});
export const reengageInput = z.object({
  personId: z.uuid(),
  accessValidUntil: z.iso.datetime(),
});

export const dismissDuplicateInput = z.object({
  personIdA: z.uuid(),
  personIdB: z.uuid(),
  reason: z.string().trim().max(2000).optional(),
});
export const listDuplicateCandidatesInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const checkExistingInput = z.object({
  givenName: z.string().trim().max(200).optional(),
  familyName: z.string().trim().max(200).optional(),
  dateOfBirth: z.iso.date().optional(),
  contactEmail: z.string().trim().max(320).optional(),
  agencyWorkerReference: z.string().trim().max(100).optional(),
});
export type CheckExistingInput = z.infer<typeof checkExistingInput>;

export const createPersonInput = z.object({
  displayName: z.string().trim().min(1).max(400),
  givenName: z.string().trim().max(200).optional(),
  familyName: z.string().trim().max(200).optional(),
  dateOfBirth: z.iso.date().optional(),
  contactEmail: z.string().trim().max(320).optional(),
  agencyWorkerReference: z.string().trim().max(100).optional(),
  relationshipType: relationshipTypeSchema,
  accessValidUntil: z.iso.datetime().optional(),
  // Creating despite candidate matches demands an explicit, journalled override.
  overrideMatches: z
    .object({
      candidatePersonIds: z.array(z.uuid()).min(1),
      reason: reasonSchema,
    })
    .optional(),
});
export type CreatePersonInput = z.infer<typeof createPersonInput>;

export const setProfileStatusInput = z.object({
  personId: z.uuid(),
  to: profileStatusSchema,
  reason: reasonSchema,
});
export const convertToEmployeeInput = z.object({ personId: z.uuid(), reason: reasonSchema });

export const invitePersonInput = z.object({
  personId: z.uuid(),
  email: z.string().trim().toLowerCase().max(320),
});

// --- platform.authz router (core plan 04 §5.1) ---

export const roleKeySchema = z.enum(ROLE_KEYS);
export type RoleKeyInput = z.infer<typeof roleKeySchema>;
export const moduleKeySchema = z.enum(MODULE_KEYS);
export type ModuleKeyInput = z.infer<typeof moduleKeySchema>;
export const grantStateSchema = z.enum(GRANT_STATES);
export const fieldClassSchema = z.enum(FIELD_CLASSES);

export const grantRoleInput = z.object({
  personId: z.uuid(),
  roleKey: roleKeySchema,
  module: moduleKeySchema,
  validFrom: z.iso.datetime().optional(),
  validUntil: z.iso.datetime().optional(),
});
export type GrantRoleInput = z.infer<typeof grantRoleInput>;

export const revokeGrantInput = z.object({
  grantId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});
export type RevokeGrantInput = z.infer<typeof revokeGrantInput>;

export const listGrantsInput = z.object({
  personId: z.uuid().optional(),
  roleKey: roleKeySchema.optional(),
  module: moduleKeySchema.optional(),
  // Derived in SQL (CASE over the timestamps) and filtered in SQL — the same
  // expression drives display and filter, never computed client-side.
  state: grantStateSchema.optional(),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  sortDir: z.enum(SORT_DIRECTIONS).default('desc'),
});
export type ListGrantsInput = z.infer<typeof listGrantsInput>;

export const addAllocationInput = z.object({
  adminPersonId: z.uuid(),
  personId: z.uuid(),
  validFrom: z.iso.datetime().optional(),
  validUntil: z.iso.datetime().optional(),
});
export type AddAllocationInput = z.infer<typeof addAllocationInput>;

export const endAllocationInput = z.object({
  allocationId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});
export type EndAllocationInput = z.infer<typeof endAllocationInput>;

export const listAllocationsInput = z.object({
  adminPersonId: z.uuid().optional(),
  personId: z.uuid().optional(),
  liveOnly: z.boolean().default(true),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  sortDir: z.enum(SORT_DIRECTIONS).default('desc'),
});
export type ListAllocationsInput = z.infer<typeof listAllocationsInput>;
