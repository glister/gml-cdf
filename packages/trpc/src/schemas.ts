import { z } from 'zod';
import { defineFieldClassification, schemaUpTo } from './lib/field-classification.js';
import {
  APPROVAL_ASSIGNEE_SOURCES,
  APPROVAL_DECISIONS,
  APPROVAL_SORTS,
  APPROVAL_STATUSES,
  CONFIG_SORTS,
  DELIVERY_SORTS,
  DELIVERY_STATUSES,
  FIELD_CLASSES,
  GRANT_STATES,
  LOOKUP_LIST_TYPES,
  LOOKUP_SORTS,
  MODULE_KEYS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_CONTEXTUAL_REFS,
  NOTIFICATION_RECIPIENT_KINDS,
  NOTIFICATION_STATUSES,
  PERSON_FLAG_TYPES,
  PERSON_SORTS,
  PERSON_STATUSES,
  PROFILE_STATUSES,
  RELATIONSHIP_TYPES,
  ROLE_KEYS,
  SCHEDULED_ACTION_SORTS,
  SCHEDULED_ACTION_STATUSES,
  SORT_DIRECTIONS,
  TASK_DEPENDENCY_KINDS,
  TASK_DUE_MODES,
  TASK_SORTS,
  TASK_STATUSES,
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

// --- Task & checklist engine (core plan 08 §5.1) ----------------------------

export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatusValue = z.infer<typeof taskStatusSchema>;

export const taskDependencyKindSchema = z.enum(TASK_DEPENDENCY_KINDS);

/** A stream reference — the case a task belongs to, in journal vocabulary. */
export const taskStreamRef = z.object({
  streamType: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'streamType is <module>.<entity> (ADR-0021)'),
  streamId: z.uuid(),
});
export type TaskStreamRef = z.infer<typeof taskStreamRef>;

/**
 * How a task's due date is expressed (PL-013), as a discriminated union so the
 * three shapes of the table's CHECK constraints are unrepresentable-if-wrong at
 * the boundary too.
 *
 * `anchor_relative` carries the *spec*, not a date: the engine resolves it
 * against the anchor values the caller supplies, and re-resolves it when the
 * anchor later moves. An offset of ±366 days is the outer bound — beyond a year
 * either side of an anchor the relationship is not a due date, it is a coincidence.
 */
export const dueSpecSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('absolute'), dueAt: z.iso.datetime() }),
  z.object({
    mode: z.literal('anchor_relative'),
    anchorName: z.string().trim().min(1).max(100),
    offsetDays: z.number().int().min(-366).max(366),
  }),
]);
export type DueSpec = z.infer<typeof dueSpecSchema>;

/** `platform.task.due_mode`, for outputs that echo the stored mode. */
export const taskDueModeSchema = z.enum(TASK_DUE_MODES);

/**
 * One item in a task list handed to `raiseTaskList` (and the shape a workflow
 * definition's `tasks.raiseList` effect params carry).
 *
 * `ref` is **list-local**: dependencies inside one raise name each other by ref,
 * because the ids do not exist until the insert. `gates` are named conditions on
 * the case; a task carrying one is raised `blocked` unless that gate has already
 * opened. Titles are instructions, never personal data (§8).
 */
export const taskSpecSchema = z.object({
  ref: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9_.-]*$/, 'ref is a short slug: lowercase letters, digits, _ . -'),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  lane: z.string().trim().min(1).max(100).optional(),
  assigneeRoleId: z.uuid(),
  due: dueSpecSchema.default({ mode: 'none' }),
  /** List-local refs of tasks that must reach a terminal state first. */
  dependsOn: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  /** Named gates on the case that must open first. */
  gates: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  /** Provenance, e.g. `platform.pilot.checklist@1#it_setup`. */
  sourceRef: z.string().trim().max(200).optional(),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

/**
 * Anchor values supplied by the raising module — `{ start_date: '2026-09-14' }`.
 * The engine defines no anchor vocabulary: it resolves what it is given and
 * rejects a task whose anchor is absent, rather than guessing a date.
 */
export const taskAnchorsSchema = z.record(z.string().trim().min(1).max(100), z.iso.date());
export type TaskAnchors = z.infer<typeof taskAnchorsSchema>;

/**
 * My-tasks. Every facet below is a `WHERE`/`ORDER BY` in SQL (ADR-0004) — the
 * client collects intent and passes it on, and never filters the page it holds.
 */
export const myTasksInput = z.object({
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(100).default(25),
  /** Defaults to the actionable set — what is on the caller's plate now. */
  status: z.array(taskStatusSchema).min(1).max(4).optional(),
  lane: z.string().trim().max(100).optional(),
  streamType: z.string().trim().max(100).optional(),
  streamId: z.uuid().optional(),
  overdueOnly: z.boolean().default(false),
  dueBefore: z.iso.datetime().optional(),
  /** ILIKE on title — applied in SQL. */
  search: z.string().trim().max(200).optional(),
  sort: z.enum(TASK_SORTS).default('due'),
  sortDir: z.enum(SORT_DIRECTIONS).default('asc'),
});
export type MyTasksInput = z.infer<typeof myTasksInput>;

/**
 * A row in a task list. `overdue` is **computed in SQL**, not derived here from
 * `dueAt`: the list, the dashboard counts and the reminder sweep must agree on
 * one expression, and a second one in JavaScript is how they stop agreeing.
 */
export const taskSummarySchema = z.object({
  id: z.uuid(),
  streamType: z.string(),
  streamId: z.uuid(),
  lane: z.string().nullable(),
  title: z.string(),
  assigneeRoleId: z.uuid(),
  assigneeRoleName: z.string(),
  claimedBy: z.uuid().nullable(),
  claimedByName: z.string().nullable(),
  status: taskStatusSchema,
  dueAt: z.iso.datetime().nullable(),
  overdue: z.boolean(),
  blockedCount: z.number().int(),
  raisedAt: z.iso.datetime(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const myTasksOutput = z.object({
  items: z.array(taskSummarySchema),
  nextCursor: z.string().nullable(),
});

export const taskRefInput = z.object({ taskId: z.uuid() });

/** One edge on the detail screen's "what blocks this" panel. */
export const taskDependencySchema = z.object({
  id: z.uuid(),
  kind: taskDependencyKindSchema,
  dependsOnTaskId: z.uuid().nullable(),
  dependsOnTaskTitle: z.string().nullable(),
  dependsOnTaskStatus: taskStatusSchema.nullable(),
  gateKey: z.string().nullable(),
  satisfiedAt: z.iso.datetime().nullable(),
});

export const taskDetailSchema = taskSummarySchema.extend({
  description: z.string().nullable(),
  dueMode: taskDueModeSchema,
  anchorName: z.string().nullable(),
  anchorOffsetDays: z.number().int().nullable(),
  source: z.enum(['workflow', 'manual']),
  sourceRef: z.string().nullable(),
  workflowInstanceId: z.uuid().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  completedByName: z.string().nullable(),
  completionNote: z.string().nullable(),
  cancelReason: z.string().nullable(),
  /** What blocks this task. */
  dependencies: z.array(taskDependencySchema),
  /** What completing this task unlocks. */
  unlocks: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      status: taskStatusSchema,
      lane: z.string().nullable(),
    }),
  ),
  /** Whether the caller holds the assignee role — drives the action buttons. */
  canAct: z.boolean(),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const completeTaskInput = z.object({
  taskId: z.uuid(),
  note: z.string().trim().max(2000).optional(),
  /**
   * HR/Administrator completing for someone else. Journalled as `onBehalfOf` —
   * an override is a decision, and the trail says whose (ADR-0011).
   */
  onBehalfOf: z.uuid().optional(),
});
export type CompleteTaskInput = z.infer<typeof completeTaskInput>;

export const cancelTaskInput = z.object({
  taskId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});
export type CancelTaskInput = z.infer<typeof cancelTaskInput>;

/**
 * An ad-hoc task on a case. Dependencies are given as **existing task ids** in
 * the same stream (a manual task joins a graph that already exists), and gates
 * by key. Cycles are rejected before anything is written.
 */
export const createManualTaskInput = taskStreamRef.extend({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  lane: z.string().trim().min(1).max(100).optional(),
  assigneeRoleId: z.uuid(),
  due: dueSpecSchema.default({ mode: 'none' }),
  /** Anchor values, required when `due.mode` is `anchor_relative`. */
  anchors: taskAnchorsSchema.default({}),
  dependsOnTaskIds: z.array(z.uuid()).max(50).default([]),
  gates: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});
export type CreateManualTaskInput = z.infer<typeof createManualTaskInput>;

export const caseProgressInput = taskStreamRef;

/**
 * The generic case dashboard's numbers (PL-015). Every figure is one grouped
 * SQL pass over `platform.task` / `platform.task_dependency` — there is no
 * stored "percent complete" and no JavaScript arithmetic over a page of rows.
 */
export const caseProgressOutput = z.object({
  lanes: z.array(
    z.object({
      lane: z.string().nullable(),
      total: z.number().int(),
      done: z.number().int(),
      open: z.number().int(),
      blocked: z.number().int(),
      cancelled: z.number().int(),
      overdue: z.number().int(),
      nextDueAt: z.iso.datetime().nullable(),
    }),
  ),
  gates: z.array(
    z.object({
      gateKey: z.string(),
      open: z.boolean(),
      blockedTaskCount: z.number().int(),
    }),
  ),
  bottlenecks: z.array(
    z.object({
      kind: taskDependencyKindSchema,
      ref: z.string(),
      title: z.string().nullable(),
      blockedCount: z.number().int(),
      oldestBlockedRaisedAt: z.iso.datetime(),
    }),
  ),
});
export type CaseProgressOutput = z.infer<typeof caseProgressOutput>;

// --- Approval engine (core plan 09 §5.1) ------------------------------------

export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatusValue = z.infer<typeof approvalStatusSchema>;

export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export const approvalAssigneeSourceSchema = z.enum(APPROVAL_ASSIGNEE_SOURCES);

/** The business record a sign-off is about, in journal vocabulary (ADR-0021). */
export const approvalSubjectRef = z.object({
  subjectType: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'subjectType is <module>.<entity> (ADR-0021)'),
  subjectId: z.uuid(),
});
export type ApprovalSubjectRef = z.infer<typeof approvalSubjectRef>;

/**
 * The PII-minimal facts warning providers and threshold rules read (§4.2).
 *
 * Values are scalars only — no nested objects, no arrays. That is not a
 * convenience limit: `context` is journalled on the `requested` event, and the
 * moment it can carry a structure it can carry a profile row (ADR-0019). A
 * provider that needs richer detail queries for it live, under its own RBAC.
 */
export const approvalContextSchema = z.record(
  z.string().trim().min(1).max(100),
  z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
);
export type ApprovalContext = z.infer<typeof approvalContextSchema>;

/**
 * A warning acknowledgement — the pair that is stored and journalled (PL-017).
 *
 * `message` and `detail` are rendered live and deliberately never persisted:
 * they are prose about people ("Sam and Alex are already off that week") and
 * would drag exactly the content ADR-0019 keeps out of the journal into an
 * append-only table.
 */
export const warningAckSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(100),
});
export type WarningAck = z.infer<typeof warningAckSchema>;

/**
 * A live warning, as `previewWarnings` and `byId` return it.
 *
 * `severity` is fixed at `'warning'` on purpose. PL-017 and HL-038 are explicit
 * that clash and capacity information **informs** and never blocks; adding an
 * `'error'` level would be the first step towards a provider that auto-rejects,
 * which §1's anti-scope rules out. A rule that must block is a workflow guard
 * (plan 07), not a warning.
 */
export const approvalWarningSchema = z.object({
  provider: z.string(),
  code: z.string(),
  severity: z.literal('warning'),
  message: z.string(),
  detail: z.unknown().optional(),
});
export type ApprovalWarning = z.infer<typeof approvalWarningSchema>;

/** Open a standalone request (§5.1). Workflow-bound ones open server-side. */
export const submitApprovalInput = approvalSubjectRef.extend({
  context: approvalContextSchema.default({}),
  /** What the requester was shown and ticked at submit — codes only. */
  acknowledgedWarnings: z.array(warningAckSchema).max(50).default([]),
});
export type SubmitApprovalInput = z.infer<typeof submitApprovalInput>;

export const previewWarningsInput = approvalSubjectRef.extend({
  context: approvalContextSchema.default({}),
});

/**
 * Record the decisive decision (PL-016).
 *
 * The `superRefine` is the **belt** for the mandatory rejection reason; the
 * `approval_decision_reason_chk` CHECK constraint is the braces. Both exist
 * because AC-D2 requires a reasonless rejection to be impossible "via the UI,
 * the API and direct SQL", and a schema alone cannot speak for the third.
 */
export const decideApprovalInput = z
  .object({
    requestId: z.uuid(),
    decision: approvalDecisionSchema,
    reason: z.string().trim().max(4000).optional(),
    acknowledgedWarnings: z.array(warningAckSchema).max(50).default([]),
  })
  .superRefine((input, ctx) => {
    if (input.decision === 'rejected' && (input.reason ?? '').length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'a reason is required when rejecting — the requester is told why',
      });
    }
  });
export type DecideApprovalInput = z.infer<typeof decideApprovalInput>;

export const cancelApprovalInput = z.object({
  requestId: z.uuid(),
  reason: z.string().trim().max(4000).optional(),
});

export const approvalRefInput = z.object({ requestId: z.uuid() });

/** What `submit` answers with — including "nobody needed to approve this". */
export const submitApprovalOutput = z.object({
  /** `null` when the threshold did not call for approval (§12.2 Q2). */
  requestId: z.uuid().nullable(),
  status: approvalStatusSchema.nullable(),
  /** True when the threshold auto-approved it; the fact is journalled either way. */
  autoApproved: z.boolean(),
  /** How many people the policy resolved to — 0 is a real, journalled answer. */
  notifiedCount: z.number().int(),
});

/** A request as most surfaces need it. */
export const approvalRequestSchema = approvalSubjectRef.extend({
  id: z.uuid(),
  status: approvalStatusSchema,
  policyKey: z.string(),
  policyVersion: z.number().int().nullable(),
  workflowInstanceId: z.uuid().nullable(),
  workflowAction: z.string().nullable(),
  requestedBy: z.uuid().nullable(),
  requestedByName: z.string().nullable(),
  context: approvalContextSchema,
  submittedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

/**
 * The approvals inbox. Every facet is a `WHERE`/`ORDER BY` in SQL, and so is
 * **eligibility** — the caller's live role grants and delegations are joined
 * into the query (ADR-0004, §5.1). Nothing is filtered over the loaded page,
 * which with keyset pagination would also corrupt the page boundary.
 */
export const approvalInboxInput = z.object({
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(100).default(25),
  /** Defaults to the outstanding set — an inbox of decided requests is a report. */
  status: z.array(approvalStatusSchema).min(1).max(4).optional(),
  subjectType: z.string().trim().max(100).optional(),
  /**
   * Include requests the caller may act on only through an override role.
   * Off by default, so HR's inbox is *their* work rather than everyone's
   * (HL-033: they may act on any request without being shown all of them).
   */
  includeOverride: z.boolean().default(false),
  sort: z.enum(APPROVAL_SORTS).default('submitted'),
  sortDir: z.enum(SORT_DIRECTIONS).default('asc'),
});
export type ApprovalInboxInput = z.infer<typeof approvalInboxInput>;

/** A row in the inbox. `waitingDays` is computed in SQL, like `overdue` on tasks. */
export const approvalListItemSchema = approvalSubjectRef.extend({
  id: z.uuid(),
  status: approvalStatusSchema,
  policyKey: z.string(),
  requestedBy: z.uuid().nullable(),
  requestedByName: z.string().nullable(),
  submittedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  /** Whole days the request has been outstanding — the chase's raw material. */
  waitingDays: z.number().int(),
  /** True when the caller reaches this request only via an override role. */
  viaOverride: z.boolean(),
  /** Set when the caller's authority comes from a delegation. */
  viaDelegationId: z.uuid().nullable(),
});
export type ApprovalListItem = z.infer<typeof approvalListItemSchema>;

export const approvalInboxOutput = z.object({
  items: z.array(approvalListItemSchema),
  nextCursor: z.string().nullable(),
});

/** Who was asked, and whether they were told (§4.5 — the notification record). */
export const approvalAssigneeSchema = z.object({
  personId: z.uuid(),
  personName: z.string().nullable(),
  source: approvalAssigneeSourceSchema,
  roleName: z.string().nullable(),
  delegationId: z.uuid().nullable(),
  notifiedAt: z.iso.datetime().nullable(),
});

/** The decisive decision, as the detail screen renders it. */
export const approvalDecisionRecordSchema = z.object({
  id: z.uuid(),
  decision: approvalDecisionSchema,
  actorPersonId: z.uuid(),
  actorName: z.string().nullable(),
  delegationId: z.uuid().nullable(),
  /** Whose authority the decider was carrying, when it came via a delegation. */
  onBehalfOfName: z.string().nullable(),
  reason: z.string().nullable(),
  acknowledgedWarnings: z.array(warningAckSchema),
  decidedAt: z.iso.datetime(),
});

/**
 * Request detail: the row, who was asked, the decision, and **live** warnings.
 *
 * `viewerCanDecide` is re-computed on every read from live policy resolution
 * (§4.5), which is why the decision screen can honestly grey out its buttons for
 * someone who was notified yesterday and has since left the role.
 */
export const approvalDetailSchema = z.object({
  request: approvalRequestSchema,
  assignees: z.array(approvalAssigneeSchema),
  decision: approvalDecisionRecordSchema.nullable(),
  warnings: z.array(approvalWarningSchema),
  viewerCanDecide: z.boolean(),
  /** Set when the viewer's authority comes from a delegation. */
  viewerDelegationId: z.uuid().nullable(),
  /** Why they cannot decide, when they cannot — shown rather than left blank. */
  viewerCannotDecideReason: z
    .enum(['not_eligible', 'already_decided', 'cancelled', 'is_requester'])
    .nullable(),
});
export type ApprovalDetail = z.infer<typeof approvalDetailSchema>;

export const listApprovalsBySubjectInput = approvalSubjectRef;

// --- Delegations (HL-035 driver) --------------------------------------------

export const approvalDelegationSchema = z.object({
  id: z.uuid(),
  delegatorPersonId: z.uuid(),
  delegatorName: z.string().nullable(),
  delegatePersonId: z.uuid(),
  delegateName: z.string().nullable(),
  /** `null` = every subject type. */
  subjectType: z.string().nullable(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
  /** Computed in SQL against `now()`, so the list and the resolver agree. */
  active: z.boolean(),
});
export type ApprovalDelegation = z.infer<typeof approvalDelegationSchema>;

export const listDelegationsInput = z.object({
  /** Omitted = the caller's own. Naming someone else is an administrator act. */
  personId: z.uuid().optional(),
  /** Include lapsed and revoked ones — off by default. */
  includeInactive: z.boolean().default(false),
});

export const createDelegationInput = z
  .object({
    delegatePersonId: z.uuid(),
    /** Omitted = every subject type. */
    subjectType: z.string().trim().max(100).optional(),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime(),
    reason: z.string().trim().max(1000).optional(),
    /**
     * Administrators arranging cover for an absent approver (HL-035). Omitted
     * means the caller is delegating their own authority.
     */
    delegatorPersonId: z.uuid().optional(),
  })
  .superRefine((input, ctx) => {
    if (Date.parse(input.validTo) <= Date.parse(input.validFrom)) {
      ctx.addIssue({
        code: 'custom',
        path: ['validTo'],
        message: 'the delegation must end after it starts',
      });
    }
  });
export type CreateDelegationInput = z.infer<typeof createDelegationInput>;

export const revokeDelegationInput = z.object({ delegationId: z.uuid() });

// --- Notifications & reminders (core plan 10 §5.5, PL-019…021) ---------------

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannelValue = z.infer<typeof notificationChannelSchema>;

export const notificationRecipientKindSchema = z.enum(NOTIFICATION_RECIPIENT_KINDS);
export const notificationContextualRefSchema = z.enum(NOTIFICATION_CONTEXTUAL_REFS);
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);

/**
 * How a notification is addressed (PL-021) — **the schema with no person in it.**
 *
 * A discriminated union rather than three optional fields, so "exactly one
 * shape" is a type-level property on the way in as well as a CHECK constraint at
 * rest. There is no `{ kind: 'person', personId }` member and there will not be
 * one: a request for "notify Jane" is a request for a role or a designated
 * approver policy, and the right time to say so is at design time (§1
 * anti-scope).
 */
export const recipientSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('role'),
    roleId: z.uuid('choose a role'),
    /** Narrows to holders of that role *for this team* — see plan 09 §4.5. */
    teamId: z.uuid().nullish(),
  }),
  z.object({
    kind: z.literal('policy'),
    /** `config:<namespace.key>` — resolved through the approval-policy resolver. */
    policyRef: z.string().trim().min(1).max(200),
  }),
  z.object({ kind: z.literal('contextual'), ref: notificationContextualRefSchema }),
]);
export type RecipientSpec = z.infer<typeof recipientSpecSchema>;

/** What a notification is about, in journal stream vocabulary (ADR-0021). */
export const notificationSubjectRef = z.object({
  streamType: z.string().trim().min(1).max(100),
  streamId: z.uuid(),
});

export const myNotificationsInput = z.object({
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(50).default(20),
  /** Applied as `read_at IS NULL` in SQL — never over the loaded page (ADR-0004). */
  unreadOnly: z.boolean().default(false),
});
export type MyNotificationsInput = z.infer<typeof myNotificationsInput>;

/**
 * One row in the inbox.
 *
 * `title`/`body` are the rendered, PII-minimal content the kind's registered
 * renderer produced (§4.6). They carry no special-category detail on any
 * channel — a sickness notification says an absence was recorded and links to
 * the RBAC-guarded record, exactly as the calendar shows "absence" only
 * (SA-023).
 */
export const notificationListItemSchema = z.object({
  /** The **delivery** id — what `markRead` acts on, and what is unique per person. */
  deliveryId: z.uuid(),
  notificationId: z.uuid(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  actionUrl: z.string().nullable(),
  subjectStreamType: z.string().nullable(),
  subjectStreamId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type NotificationListItem = z.infer<typeof notificationListItemSchema>;

export const myNotificationsOutput = z.object({
  items: z.array(notificationListItemSchema),
  nextCursor: z.string().nullable(),
});

export const markNotificationReadInput = z.object({ deliveryId: z.uuid() });

export const unreadCountOutput = z.object({ count: z.number().int().min(0) });

/**
 * The admin send-test input (§9.7) — the pilot that proves resolution and
 * dispatch with no HR module in existence.
 *
 * `note` is free text the administrator types into their own test message. It is
 * the *only* free text any notification body carries, it never leaves the
 * `admin.test` kind, and it is bounded — a test send is the one case where the
 * person choosing the words and the person reading them are the same.
 */
export const sendTestNotificationInput = z.object({
  recipient: recipientSpecSchema,
  channels: z.array(notificationChannelSchema).min(1).max(3).optional(),
  note: z.string().trim().max(200).optional(),
});
export type SendTestNotificationInput = z.infer<typeof sendTestNotificationInput>;

export const sendTestNotificationOutput = z.object({
  notificationId: z.uuid(),
  /** How many people the spec resolved to — 0 is a real, reportable answer. */
  resolvedRecipients: z.number().int().min(0),
});

/** Delivery diagnostics: every facet is a SQL `where`, none a client filter. */
export const adminDeliveriesInput = z.object({
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(100).default(25),
  status: z.array(deliveryStatusSchema).min(1).max(5).optional(),
  channel: z.array(notificationChannelSchema).min(1).max(3).optional(),
  kind: z.string().trim().max(100).optional(),
  personId: z.uuid().optional(),
  sort: z.enum(DELIVERY_SORTS).default('created_at'),
  sortDir: z.enum(SORT_DIRECTIONS).default('desc'),
});
export type AdminDeliveriesInput = z.infer<typeof adminDeliveriesInput>;

/**
 * A diagnostics row. It shows the notification's own title and nothing more —
 * an administrator debugging delivery sees no more content than the recipient
 * already received, which is already SA-023-clean (§8).
 */
export const deliveryDiagnosticSchema = z.object({
  deliveryId: z.uuid(),
  notificationId: z.uuid(),
  kind: z.string(),
  title: z.string(),
  personId: z.uuid(),
  personName: z.string().nullable(),
  resolvedVia: notificationRecipientKindSchema,
  channel: notificationChannelSchema,
  status: deliveryStatusSchema,
  attemptCount: z.number().int().min(0),
  attemptedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  providerRef: z.string().nullable(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type DeliveryDiagnostic = z.infer<typeof deliveryDiagnosticSchema>;

export const adminDeliveriesOutput = z.object({
  items: z.array(deliveryDiagnosticSchema),
  nextCursor: z.string().nullable(),
});
