import {
  can,
  OWNER_ONLY_PERMISSIONS,
  PERMISSIONS,
  PERMISSIONS_BY_ROLE,
  permissionsFor,
  USER_ROLES,
  type Permission,
} from '../utils/permissions';

/**
 * The permission map.
 *
 * Pinned as data rather than as a handful of spot checks, because this file is
 * the only thing standing between a role edit and a cashier who can void their
 * own sales. Each assertion below names the control it exists to keep.
 */

/** The five things the brief makes owner-only. Spelled out, not derived. */
const EXPECTED_OWNER_ONLY: Permission[] = [
  'sales:void',
  'inventory:adjust',
  'inventory:write_off',
  'tax:change',
  'staff:manage',
];

/** What counter staff may do: run the till and serve the customer in front of them. */
const EXPECTED_STAFF: Permission[] = [
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

/**
 * The whole vocabulary, spelled out.
 *
 * This list is the reason the two below it can be trusted. Without it, every
 * assertion here derives its expectation from `PERMISSIONS` itself — comparing
 * the map to the map — so adding a permission passes every test while quietly
 * granting it to whoever the subtraction happens to reach.
 */
const EXPECTED_ALL: Permission[] = [
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
];

/**
 * What a pharmacist may do, spelled out rather than computed as
 * "everything except the owner-only five".
 *
 * The module derives it that way, and the derivation is the right shape for the
 * code — but a test that repeats the derivation cannot detect a permission
 * arriving in the pharmacist's hands by accident. Spelled out, an addition to
 * `PERMISSIONS` that was never decided on for this role fails here.
 */
const EXPECTED_PHARMACIST: Permission[] = [
  'sales:create',
  'sales:read',
  'payments:add',
  'payments:verify',
  'inventory:read',
  'inventory:receive',
  'inventory:product:write',
  'inventory:import',
  'inventory:recall:read',
  'inventory:alerts:scan',
  'reports:read',
  'tax:read',
  'patients:read',
  'patients:write',
  'screenings:write',
  'consultations:write',
  'prescriptions:approve',
  'notifications:read',
  'notifications:refresh',
];

describe('permission map', () => {
  it('has exactly three roles and no super admin', () => {
    // A fourth role is a decision, not an edit. `super_admin` in particular
    // would sit outside the pharmacy scope that every query is filtered by,
    // which is the whole tenancy model of this build.
    expect([...USER_ROLES].sort()).toEqual(['pharmacist', 'pharmacy_owner', 'staff']);
    expect(Object.keys(PERMISSIONS_BY_ROLE).sort()).toEqual([...USER_ROLES].sort());
  });

  it('pins the whole permission vocabulary, so an addition is a decision', () => {
    expect([...PERMISSIONS].sort()).toEqual([...EXPECTED_ALL].sort());
  });

  it('gives a pharmacist exactly the listed set, not everything the subtraction reaches', () => {
    expect(permissionsFor('pharmacist').sort()).toEqual([...EXPECTED_PHARMACIST].sort());
  });

  it('gives the owner every permission', () => {
    expect(permissionsFor('pharmacy_owner').sort()).toEqual([...PERMISSIONS].sort());
    for (const permission of PERMISSIONS) {
      expect(can('pharmacy_owner', permission)).toBe(true);
    }
  });

  it('withholds exactly the five owner-only permissions from a pharmacist', () => {
    for (const permission of EXPECTED_OWNER_ONLY) {
      expect(can('pharmacist', permission)).toBe(false);
    }
    const expected = PERMISSIONS.filter((p) => !EXPECTED_OWNER_ONLY.includes(p));
    expect(permissionsFor('pharmacist').sort()).toEqual([...expected].sort());
  });

  it('gives counter staff the till and nothing else', () => {
    expect(permissionsFor('staff').sort()).toEqual([...EXPECTED_STAFF].sort());
  });

  it('pins the owner-only set itself, so it cannot grow quietly', () => {
    expect([...OWNER_ONLY_PERMISSIONS].sort()).toEqual([...EXPECTED_OWNER_ONLY].sort());
  });

  it('keeps staff from approving the prescriptions they sell', () => {
    // Separation of duties. A role that can both ring up a prescription sale
    // and approve it can dispense anything to anyone with no second pair of
    // eyes, and the audit trail would show one person doing both correctly.
    expect(can('staff', 'sales:create')).toBe(true);
    expect(can('staff', 'prescriptions:approve')).toBe(false);
    expect(can('pharmacist', 'prescriptions:approve')).toBe(true);
  });

  it('keeps staff from verifying the payments they take', () => {
    // Recording a payment and confirming it arrived are two hands. Staff do the
    // first; only a pharmacist or the owner confirms mobile money landed.
    expect(can('staff', 'payments:add')).toBe(true);
    expect(can('staff', 'payments:verify')).toBe(false);
  });

  it('keeps staff out of stock corrections, reports and staff management', () => {
    // An adjustment or a write-off with no reason recorded is stock that
    // disappeared; reports are the owner's business numbers; and a role that
    // could add accounts could add an owner.
    for (const permission of [
      'inventory:receive',
      'inventory:adjust',
      'inventory:write_off',
      'inventory:import',
      'inventory:product:write',
      'reports:read',
      'staff:manage',
      'tax:change',
      'screenings:write',
      'consultations:write',
    ] as Permission[]) {
      expect(can('staff', permission)).toBe(false);
    }
  });

  it('lets staff read the tax rates they have to price with, and only the owner set them', () => {
    // A till cannot price a sale without the rates, and the offline till in Phase 9
    // has to hold a cached copy to price anything at all during an outage — so
    // reading them is part of selling rather than a report somebody is shown.
    // Setting them decides what every sale in the pharmacy charges, which is why
    // that half is owner-only and this test pins the two halves separately: a
    // change that moved `tax:read` into the owner-only set would break the till for
    // every counter sale, and a change that moved `tax:change` out of it would let a
    // cashier reprice the pharmacy.
    expect(can('staff', 'tax:read')).toBe(true);
    expect(can('pharmacist', 'tax:read')).toBe(true);
    expect(can('pharmacy_owner', 'tax:read')).toBe(true);
    expect(can('staff', 'tax:change')).toBe(false);
    expect(can('pharmacist', 'tax:change')).toBe(false);
    expect(can('pharmacy_owner', 'tax:change')).toBe(true);
  });

  it('lets staff read the recall list, because a recall is answered at the counter', () => {
    // A recalled batch must be refusable by whoever is serving, without having
    // to find a pharmacist first. Reading it is not the same as writing stock.
    expect(can('staff', 'inventory:recall:read')).toBe(true);
    expect(can('staff', 'inventory:adjust')).toBe(false);
  });

  it('keeps staff from triggering the alert scan, while still showing them the result', () => {
    // A scan writes rows. Whoever can raise a stock alert can also crowd out
    // last week's unread ones, and the panel is the pharmacist's and the
    // owner's working list. Seeing the alerts is `notifications:read`, which
    // staff do have — the split is between reading the list and regenerating it.
    expect(can('staff', 'inventory:alerts:scan')).toBe(false);
    expect(can('staff', 'notifications:read')).toBe(true);
    expect(can('pharmacist', 'inventory:alerts:scan')).toBe(true);
    expect(can('pharmacy_owner', 'inventory:alerts:scan')).toBe(true);
  });

  it('keeps staff from running the reminder scheduler, while still showing them what it wrote', () => {
    // A refresh writes a status onto every reminder it picks up, and `not sent` is
    // a clinical statement that the patient was not told. That is the same shape of
    // control as the alert scan above: whoever may cause a record to be written may
    // not be whoever is served by it. Reading the bell is `notifications:read`,
    // which staff do have, so a cashier can still see that a reminder went nowhere
    // and say so out loud at the counter.
    expect(can('staff', 'notifications:refresh')).toBe(false);
    expect(can('staff', 'notifications:read')).toBe(true);
    expect(can('pharmacist', 'notifications:refresh')).toBe(true);
    expect(can('pharmacy_owner', 'notifications:refresh')).toBe(true);
  });

  it('holds no permission that every role lacks', () => {
    // A permission nobody has is either a typo or a feature that was never
    // wired to a route. Either way it should not be sitting in the map
    // implying that something checks it.
    const unreachable = PERMISSIONS.filter(
      (permission) => !USER_ROLES.some((role) => can(role, permission))
    );
    expect(unreachable).toEqual([]);
  });

  it('derives permissionsFor from can, so the two cannot disagree', () => {
    for (const role of USER_ROLES) {
      const listed = permissionsFor(role);
      expect(listed.every((permission) => can(role, permission))).toBe(true);
      expect(listed.length).toBe(PERMISSIONS_BY_ROLE[role].size);
    }
  });

  it('lists every permission exactly once', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });
});
