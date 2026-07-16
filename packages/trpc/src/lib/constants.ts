/**
 * Constant tuples that back the Zod enums in `../schemas.ts`. Keeping them as
 * `as const` tuples lets us derive both the Zod enum and the TS literal-union
 * type from one source. `@repo/db`'s `.kysely-codegenrc.json` INLINES the same
 * literals for CHECK columns rather than importing from here (avoids a cycle).
 */

/** Better Auth admin-plugin roles. */
export const USER_ROLES = ['admin', 'agent'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Sort directions for keyset-paginated lists. */
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];
