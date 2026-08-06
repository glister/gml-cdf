import { z } from 'zod';
import { defineFieldClassification, schemaUpTo } from './lib/field-classification.js';
import {
  CONFIG_SORTS,
  FIELD_CLASSES,
  GRANT_STATES,
  LOOKUP_LIST_TYPES,
  LOOKUP_SORTS,
  MODULE_KEYS,
  PERSON_FLAG_TYPES,
  PERSON_SORTS,
  PERSON_STATUSES,
  PROFILE_STATUSES,
  RELATIONSHIP_TYPES,
  ROLE_KEYS,
  SCHEDULED_ACTION_SORTS,
  SCHEDULED_ACTION_STATUSES,
  SORT_DIRECTIONS,
  TEAM_SORTS,
  USER_ROLES,
  WORKFLOW_INSTANCE_SORTS,
} from './lib/constants.js';

/**
 * Flat module of Zod input/output schemas + inferred types. Enums are derived
 * from the constant tuples in `./lib/constants.ts`. Every router pulls its
 * validators from here.
 *
 * **Exported as the `@repo/trpc/schemas` subpath, and that is how clients must
 * import it.** A form validating with a shared schema needs the Zod object at
 * *runtime*, and reaching it through the package root would pull in the router —
 * and therefore `@trpc/server` — landing "You're trying to use @trpc/server in a
 * non-server environment" in the browser. This module imports nothing but Zod
 * and the constant tuples, so the subpath is safe in any bundle. The root export
 * stays type-only on the client (`import type { AppRouter }`).
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

// --- users router (Better Auth framework operations only — plan 04 Q1) ---

export const updateUserRoleInput = z.object({
  id: z.string().min(1),
  role: userRoleEnum,
});
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleInput>;

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

// --- Field classification pilot (core plan 04 §5.1, PL-003, ADR-0015) ---
//
// The pattern every entity follows: one classification map covering EVERY
// exposed column (an unclassified column is a compile error, not a silently
// visible field), and role-variant output schemas derived from it. HR entities
// adopt the same shape later — `employeeProfileFull` vs
// `employeeProfileRestricted`, `hr.employee_sensitive`, `hr.absence_medical`.

/** Every column `platform.person` exposes through the API. */
const personFields = z.object({
  id: z.uuid(),
  relationship_type: relationshipTypeSchema,
  profile_status: profileStatusSchema,
  status: personStatusSchema,
  display_name: z.string(),
  given_name: z.string().nullable(),
  family_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  agency_worker_reference: z.string().nullable(),
  access_valid_until: z.union([z.string(), z.date()]).nullable(),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
});

/**
 * `platform.person` carries no special-category column by design — safeguarding
 * detail lives in `platform.person_flag`, a separate table (ADR-0015/0019), so a
 * `select *` here cannot leak it. Contact detail and date of birth are
 * `sensitive`: needed by HR, not by a peer.
 */
export const personClassification = defineFieldClassification('platform.person', personFields, {
  id: 'internal',
  relationship_type: 'internal',
  profile_status: 'internal',
  status: 'internal',
  display_name: 'internal',
  given_name: 'internal',
  family_name: 'internal',
  contact_email: 'sensitive',
  date_of_birth: 'sensitive',
  agency_worker_reference: 'internal',
  access_valid_until: 'internal',
  created_at: 'internal',
  updated_at: 'internal',
});

/** HR User / Administrator variant — everything up to and including sensitive. */
export const personOutputFull = schemaUpTo(personClassification, 'sensitive');
/** Everyone else, including `external` (PL-043) — internal and below only. */
export const personOutputRestricted = schemaUpTo(personClassification, 'internal');

/** Every column `platform.person_flag` exposes — the special-category pilot. */
const personFlagFields = z.object({
  id: z.uuid(),
  person_id: z.uuid(),
  flag_type: personFlagTypeSchema,
  reason: z.string(),
  raised_at: z.union([z.string(), z.date()]),
  raised_by: z.uuid(),
  ended_at: z.union([z.string(), z.date()]).nullable(),
  ended_by: z.uuid().nullable(),
  end_reason: z.string().nullable(),
  source_merge_id: z.uuid().nullable(),
  source_flag_id: z.uuid().nullable(),
});

/**
 * A safeguarding flag's *type and rationale* are special-category: they concern
 * criminal-adjacent and safeguarding matters (ADR-0019). The bookkeeping around
 * it (who raised it, when, merge lineage) is sensitive but not special-category
 * — so an authorised HR reader can see that a flag exists and its provenance
 * without the read being journalled twice over.
 */
export const personFlagClassification = defineFieldClassification(
  'platform.person_flag',
  personFlagFields,
  {
    id: 'internal',
    person_id: 'internal',
    flag_type: 'special-category',
    reason: 'special-category',
    end_reason: 'special-category',
    raised_at: 'sensitive',
    raised_by: 'sensitive',
    ended_at: 'sensitive',
    ended_by: 'sensitive',
    source_merge_id: 'internal',
    source_flag_id: 'internal',
  },
);

/** Administrator / HR User variant — includes the special-category detail. */
export const personFlagOutputFull = schemaUpTo(personFlagClassification, 'special-category');
/**
 * Everyone else. Note what survives: the *existence* of a flag and its
 * provenance, never its type or rationale — the PL-003 shape of "separate
 * sensitive detail from the operational output".
 */
export const personFlagOutputRestricted = schemaUpTo(personFlagClassification, 'sensitive');

// --- platform.lookup / platform.team routers (core plan 05 §5.1) ---

export const lookupListTypeSchema = z.enum(LOOKUP_LIST_TYPES);
export type LookupListTypeInput = z.infer<typeof lookupListTypeSchema>;

/**
 * The stable machine key. Same regex as the `lookup_code_format_check` CHECK, so
 * a value rejected here would be rejected by Postgres anyway — validated at both
 * ends because the migration mappings (DM-002) and seeds address rows by
 * `(list_type, code)`, and a code that varies by casing or spacing breaks them
 * silently.
 */
export const lookupCodeSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_]{0,63}$/, 'lowercase letters, digits and underscores only');

const lookupLabelSchema = z.string().trim().min(1).max(200);
const lookupDescriptionSchema = z.string().trim().max(1000);

export const lookupValueSchema = z.object({
  id: z.uuid(),
  listType: lookupListTypeSchema,
  code: lookupCodeSchema,
  label: lookupLabelSchema,
  description: lookupDescriptionSchema.nullable(),
  sortOrder: z.number().int(),
  active: z.boolean(),
});
export type LookupValue = z.infer<typeof lookupValueSchema>;

export const lookupOptionsInput = z.object({
  listType: lookupListTypeSchema,
  /**
   * Retired values too. Admin-only — a picker offering a deactivated value would
   * undo the point of deactivation (PL-007); this exists so an admin screen can
   * render the historical set.
   */
  includeInactive: z.boolean().default(false),
});
export type LookupOptionsInput = z.infer<typeof lookupOptionsInput>;

export const listLookupValuesInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  listType: lookupListTypeSchema.optional(),
  search: z.string().trim().max(200).optional(),
  active: z.boolean().optional(),
  sort: z.enum(LOOKUP_SORTS).default('sort_order'),
  sortDir: sortDirEnum.default('asc'),
});
export type ListLookupValuesInput = z.infer<typeof listLookupValuesInput>;

export const createLookupValueInput = z.object({
  listType: lookupListTypeSchema,
  code: lookupCodeSchema,
  label: lookupLabelSchema,
  description: lookupDescriptionSchema.optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type CreateLookupValueInput = z.infer<typeof createLookupValueInput>;

/**
 * `code` is absent by design, not by omission: it is immutable after creation
 * (§4.1.1), so there is no field to send. A rename changes `label`.
 *
 * `.strict()` is what turns that from a convention into a guard — without it a
 * client sending `code` would have it silently stripped and would believe the
 * rename succeeded. It fails loudly instead.
 */
export const updateLookupValueInput = z
  .object({
    id: z.uuid(),
    label: lookupLabelSchema.optional(),
    description: lookupDescriptionSchema.nullish(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();
export type UpdateLookupValueInput = z.infer<typeof updateLookupValueInput>;

export const setLookupActiveInput = z.object({ id: z.uuid(), active: z.boolean() });
export type SetLookupActiveInput = z.infer<typeof setLookupActiveInput>;

/**
 * Soft-delete a value created in error. `confirmNeverUsed` is a deliberate
 * speed bump, not a permission: nothing in the platform can prove non-use
 * before the consuming tables exist, so the caller asserts it and the journal
 * records who asserted it (§4.3).
 */
export const removeLookupValueInput = z.object({
  id: z.uuid(),
  confirmNeverUsed: z.literal(true),
});
export type RemoveLookupValueInput = z.infer<typeof removeLookupValueInput>;

const teamNameSchema = z.string().trim().min(1).max(200);
const teamDescriptionSchema = z.string().trim().max(1000);
/** Lowercase hex, matching `team_colour_format_check`. */
const teamColourSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-f]{6}$/);
const teamCapacitySchema = z.number().int().min(1).max(999);

export const teamSchema = z.object({
  id: z.uuid(),
  name: teamNameSchema,
  description: teamDescriptionSchema.nullable(),
  managerPersonId: z.uuid(),
  deputyPersonId: z.uuid().nullable(),
  maxConcurrentLeave: teamCapacitySchema.nullable(),
  colour: teamColourSchema.nullable(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamMembershipSchema = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  personId: z.uuid(),
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable(),
});
export type TeamMembership = z.infer<typeof teamMembershipSchema>;

export const listTeamsInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  includeArchived: z.boolean().default(false),
  sort: z.enum(TEAM_SORTS).default('name'),
  sortDir: sortDirEnum.default('asc'),
});
export type ListTeamsInput = z.infer<typeof listTeamsInput>;

/** `asAt` omitted means today — the roster as it currently stands. */
export const getTeamInput = z.object({ teamId: z.uuid(), asAt: z.iso.date().optional() });
export type GetTeamInput = z.infer<typeof getTeamInput>;

export const createTeamInput = z.object({
  name: teamNameSchema,
  description: teamDescriptionSchema.optional(),
  managerPersonId: z.uuid(),
  deputyPersonId: z.uuid().optional(),
  maxConcurrentLeave: teamCapacitySchema.optional(),
  colour: teamColourSchema.optional(),
});
export type CreateTeamInput = z.infer<typeof createTeamInput>;

export const updateTeamInput = z.object({
  teamId: z.uuid(),
  name: teamNameSchema.optional(),
  description: teamDescriptionSchema.nullish(),
  managerPersonId: z.uuid().optional(),
  deputyPersonId: z.uuid().nullish(),
  maxConcurrentLeave: teamCapacitySchema.nullish(),
  colour: teamColourSchema.nullish(),
});
export type UpdateTeamInput = z.infer<typeof updateTeamInput>;

export const archiveTeamInput = z.object({ teamId: z.uuid() });
export type ArchiveTeamInput = z.infer<typeof archiveTeamInput>;

export const addTeamMemberInput = z.object({
  teamId: z.uuid(),
  personId: z.uuid(),
  validFrom: z.iso.date(),
});
export type AddTeamMemberInput = z.infer<typeof addTeamMemberInput>;

export const endTeamMembershipInput = z.object({
  membershipId: z.uuid(),
  validTo: z.iso.date(),
});
export type EndTeamMembershipInput = z.infer<typeof endTeamMembershipInput>;

/**
 * Correcting a typo, which is a different act from ending a membership and is
 * journalled as such (§4.2): ending records a business fact, correcting moves a
 * boundary other records may already have been read against.
 */
export const correctTeamMembershipInput = z
  .object({
    membershipId: z.uuid(),
    validFrom: z.iso.date().optional(),
    validTo: z.iso.date().nullish(),
  })
  .refine((v) => v.validFrom !== undefined || v.validTo !== undefined, {
    message: 'supply at least one of validFrom or validTo',
  });
export type CorrectTeamMembershipInput = z.infer<typeof correctTeamMembershipInput>;

/**
 * Validator for a stored snapshot envelope (`@repo/db`'s `makeSnapshot`), used
 * by consuming plans when they read a `jsonb` snapshot column back. Snake_case
 * keys mirror the stored shape exactly — see `packages/db/src/lib/snapshot.ts`.
 */
export const snapshotEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    source_table: z.string(),
    source_id: z.uuid(),
    source_version: z.number().int().nullable(),
    taken_at: z.iso.datetime(),
    data,
  });

// --- platform.config router (core plan 06 §5.1) -----------------------------

/**
 * The `namespace`/`key` split mirrors the table's columns and the registry's
 * `${namespace}.${key}` name. Both patterns restate the `config_entry_*_chk`
 * CHECK constraints, so a name rejected here would be rejected by Postgres
 * anyway — validated at both ends because a key addressed with the wrong
 * casing or an extra dot would silently resolve to nothing and read as
 * "unregistered".
 */
export const configNamespaceSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]+(\.[a-z][a-z0-9_]+)*$/, 'lowercase dotted snake_case segments');
export const configKeyNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]+$/, 'a single lowercase snake_case segment');

const configKeyRef = z.object({
  namespace: configNamespaceSchema,
  key: configKeyNameSchema,
});
export type ConfigKeyRef = z.infer<typeof configKeyRef>;

/**
 * How the admin editor should render a key. Derived server-side from the
 * registered Zod schema, never guessed from the current value — a key whose
 * value happens to be `0` today is still a number key when it is unset.
 * Anything the registry expresses that these cannot (objects, arrays, unions)
 * falls to `json`, which the UI edits as validated JSON text.
 */
export const CONFIG_EDITOR_KINDS = [
  'integer',
  'number',
  'string',
  'boolean',
  'enum',
  'json',
] as const;
export const configEditorKindSchema = z.enum(CONFIG_EDITOR_KINDS);
export type ConfigEditorKind = z.infer<typeof configEditorKindSchema>;

/**
 * The shape the editor renders from — a JSON-Schema-ish descriptor produced from
 * the key's registered Zod schema, so client-side validation and the server's
 * write-path validation cannot drift apart.
 */
export const configSchemaDescriptorSchema = z.object({
  editorKind: configEditorKindSchema,
  /** `z.toJSONSchema()` output, or null for a schema it cannot express. */
  jsonSchema: z.unknown().nullable(),
  /** Present for `enum`; the permitted values in declaration order. */
  options: z.array(z.string()).nullable(),
  /** Present for `integer`/`number` where the schema declares bounds. */
  minimum: z.number().nullable(),
  maximum: z.number().nullable(),
});
export type ConfigSchemaDescriptor = z.infer<typeof configSchemaDescriptorSchema>;

/** One registry key merged with whatever entry is in force for it. */
export const configEntrySummarySchema = z.object({
  namespace: configNamespaceSchema,
  key: configKeyNameSchema,
  qualifiedName: z.string(),
  description: z.string(),
  registeredBy: z.string(),
  /** The value in force: the entry's, or the registered default. */
  value: z.unknown(),
  defaultValue: z.unknown(),
  /** True when no entry is in force and the code default applies. */
  isDefault: z.boolean(),
  version: z.number().int().nullable(),
  validFrom: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  updatedByName: z.string().nullable(),
  editableBy: z.array(roleKeySchema),
  /**
   * Whether *this caller* may edit the key. UX only — `set`/`reset` re-check it
   * server-side (ADR-0015); a client that ignores this gets a `FORBIDDEN`.
   */
  canEdit: z.boolean(),
});
export type ConfigEntrySummary = z.infer<typeof configEntrySummarySchema>;

/**
 * Registry-driven listing. Filtering is server-side, as the hard rule requires —
 * but over the **registry**, which is code, not a table, so it cannot be
 * expressed in SQL and there is nothing to paginate: the row count is fixed at
 * build time by the number of registered keys. The single SQL query behind it
 * fetches the entries in force for those keys.
 */
export const listConfigInput = z.object({
  namespace: configNamespaceSchema.optional(),
  search: z.string().trim().max(200).optional(),
  /** Only keys this caller may edit — the "what can I change?" view. */
  editableOnly: z.boolean().default(false),
  sort: z.enum(CONFIG_SORTS).default('key'),
  sortDir: sortDirEnum.default('asc'),
});
export type ListConfigInput = z.infer<typeof listConfigInput>;

/** `at` omitted means "the value in force now". */
export const getConfigInput = configKeyRef.extend({ at: z.iso.datetime().optional() });
export type GetConfigInput = z.infer<typeof getConfigInput>;

export const getConfigOutput = configEntrySummarySchema.extend({
  schema: configSchemaDescriptorSchema,
  /**
   * A change staged for a future instant, if one exists. The open row is that
   * staged successor, so a surface that showed only "current" would hide a
   * pending change entirely (§4.1).
   */
  pendingChange: z
    .object({
      version: z.number().int(),
      validFrom: z.iso.datetime(),
      value: z.unknown(),
    })
    .nullable(),
});
export type GetConfigOutput = z.infer<typeof getConfigOutput>;

/**
 * `value` is `unknown` on purpose: its shape is the key's registered Zod schema,
 * which only the registry knows. The procedure validates against that schema
 * before any write, so an invalid value is a `BAD_REQUEST` with the schema's own
 * message rather than a generic input error.
 *
 * `effectiveFrom` stages the change. Omitted means "now"; a past instant is
 * rejected, because it would rewrite decisions already made.
 */
export const setConfigInput = configKeyRef.extend({
  value: z.unknown(),
  effectiveFrom: z.iso.datetime().optional(),
});
export type SetConfigInput = z.infer<typeof setConfigInput>;

export const setConfigOutput = z.object({
  version: z.number().int(),
  validFrom: z.iso.datetime(),
});
export type SetConfigOutput = z.infer<typeof setConfigOutput>;

export const resetConfigInput = configKeyRef;
export type ResetConfigInput = z.infer<typeof resetConfigInput>;

export const configHistoryInput = configKeyRef.extend({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type ConfigHistoryInput = z.infer<typeof configHistoryInput>;

export const configHistoryRowSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  value: z.unknown(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  createdByName: z.string().nullable(),
});
export type ConfigHistoryRow = z.infer<typeof configHistoryRowSchema>;

// --- Workflow runtime & scheduled actions (core plan 07 §5.3) ---------------

/**
 * Execute a named action on an instance. `expectedState` is optimistic
 * concurrency for automation — a client that read the case a moment ago passes
 * the state it saw, and a mismatch is a conflict rather than a silent overwrite.
 */
export const workflowTransitionInput = z.object({
  instanceId: z.uuid(),
  action: z.string().trim().min(1).max(100),
  comment: z.string().trim().max(2000).optional(),
  /** Caller-supplied action input, handed to the guards. */
  input: z.record(z.string(), z.unknown()).optional(),
  expectedState: z.string().trim().max(100).optional(),
  onBehalfOf: z.uuid().optional(),
});
export type WorkflowTransitionInput = z.infer<typeof workflowTransitionInput>;

export const workflowInstanceRefInput = z.object({ instanceId: z.uuid() });

export const workflowListInstancesInput = z.object({
  workflowKey: z.string().trim().max(200).optional(),
  currentState: z.string().trim().max(100).optional(),
  /** `true` = still running, `false` = completed. Omitted = both. */
  active: z.boolean().optional(),
  subjectStreamType: z.string().trim().max(100).optional(),
  subjectStreamId: z.uuid().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  sort: z.enum(WORKFLOW_INSTANCE_SORTS).default('created_at'),
  sortDir: z.enum(SORT_DIRECTIONS).default('desc'),
});
export type WorkflowListInstancesInput = z.infer<typeof workflowListInstancesInput>;

export const listScheduledActionsInput = z.object({
  status: z.enum(SCHEDULED_ACTION_STATUSES).optional(),
  actionType: z.string().trim().max(200).optional(),
  dueFrom: z.iso.datetime().optional(),
  dueTo: z.iso.datetime().optional(),
  workflowInstanceId: z.uuid().optional(),
  subjectStreamType: z.string().trim().max(100).optional(),
  subjectStreamId: z.uuid().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  sort: z.enum(SCHEDULED_ACTION_SORTS).default('due_at'),
  sortDir: z.enum(SORT_DIRECTIONS).default('asc'),
});
export type ListScheduledActionsInput = z.infer<typeof listScheduledActionsInput>;

/**
 * A reason is mandatory. Cancelling a timer is a decision someone made, and the
 * journal event carries the reason so the trail explains it later.
 */
export const cancelScheduledActionInput = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});
export type CancelScheduledActionInput = z.infer<typeof cancelScheduledActionInput>;

export const rescheduleActionInput = z.object({
  id: z.uuid(),
  dueAt: z.iso.datetime(),
});
export type RescheduleActionInput = z.infer<typeof rescheduleActionInput>;
