/**
 * Roles and the permission map.
 *
 * Authorisation is decided here and enforced server-side on every route.
 * Hiding a button in the UI is not authorisation: the till is a browser, and a
 * browser is a suggestion.
 *
 * The map is written as what each role HAS rather than what it lacks, so
 * adding a permission later is a deliberate addition to a list instead of a
 * hole left in a subtraction.
 */

export const USER_ROLES = ['pharmacy_owner', 'pharmacist', 'staff'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PERMISSIONS = [
  'sales:create',
  'sales:read',
  'sales:void',
  'payments:add',
  'payments:verify',
  'inventory:read',
  'inventory:receive',
  'inventory:adjust',
  'inventory:write_off',
  'inventory:product:write',
  'inventory:import',
  'inventory:recall:read',
  'inventory:alerts:scan',
  'reports:read',
  'staff:manage',
  'tax:read',
  'tax:change',
  'patients:read',
  'patients:write',
  'screenings:write',
  'consultations:write',
  'prescriptions:approve',
  'notifications:read',
  'notifications:refresh',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The five things the brief makes owner-only: voiding a sale, adjusting stock,
 * writing off a batch, changing tax settings and managing staff. Everything
 * else a pharmacist needs to run the dispensary in the owner's absence.
 */
const OWNER_ONLY: readonly Permission[] = [
  'sales:void',
  'inventory:adjust',
  'inventory:write_off',
  'tax:change',
  'staff:manage',
];

const PHARMACIST: readonly Permission[] = PERMISSIONS.filter(
  (permission) => !OWNER_ONLY.includes(permission)
);

/**
 * Counter staff: run the till and serve customers. No reports, no receiving,
 * no prescription approval — a role that can both sell and approve its own
 * prescription sales is a control gap, not a convenience.
 *
 * `tax:read` is here and `tax:change` is owner-only, and the split is not about
 * secrecy. A till cannot price a sale without the rates, so whoever can create a
 * sale has to be able to read them — and Phase 9's offline till has to cache them
 * locally to price anything at all during an outage. Reading the rates is part of
 * selling. Setting them decides what every sale in the pharmacy charges, which is
 * why that half stays with the owner.
 *
 * `inventory:alerts:scan` is absent here and absent from OWNER_ONLY, which is
 * how it lands with the owner and the pharmacist: scanning rewrites the alert
 * list, and a till operator who can raise and dismiss their own stock alerts is
 * the same shape of gap as approving their own prescription.
 *
 * `notifications:refresh` is absent from both lists for the same reason and lands
 * with the same two roles. It runs the reminder scheduler on demand, and a run
 * writes a status onto every reminder it picks up — including `not sent`, which is
 * a clinical statement that the patient was not told. Whoever may approve a
 * prescription may cause the reminder for it to be dealt with; whoever may not
 * approve one may not either.
 *
 * Note what is *not* absent: `patients:read`, `patients:write` and
 * `notifications:read` are here, so counter staff can open a record at the counter,
 * note an allergy and see the bell. Reading the bell is not reading the margin.
 */
const STAFF: readonly Permission[] = [
  'sales:create',
  'sales:read',
  'payments:add',
  'inventory:read',
  'inventory:recall:read',
  'tax:read',
  'patients:read',
  'patients:write',
  'notifications:read',
];

export const PERMISSIONS_BY_ROLE: Record<UserRole, ReadonlySet<Permission>> = {
  pharmacy_owner: new Set<Permission>(PERMISSIONS),
  pharmacist: new Set<Permission>(PHARMACIST),
  staff: new Set<Permission>(STAFF),
};

export function can(role: UserRole, permission: Permission): boolean {
  return PERMISSIONS_BY_ROLE[role].has(permission);
}

export function permissionsFor(role: UserRole): Permission[] {
  return PERMISSIONS.filter((permission) => can(role, permission));
}

/** The owner-only set, exported so tests can pin exactly what it contains. */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] = OWNER_ONLY;
