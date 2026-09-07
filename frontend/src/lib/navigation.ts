/**
 * The navigation table, and a human sentence for every permission.
 *
 * ## Why the table lives in one file
 *
 * The plan's acceptance criterion for this phase is that *every nav item
 * resolves to a real page, with no dead links*. A shell that lists its
 * destinations inline cannot check that: the list and the `app/` directory are
 * two facts with nothing comparing them, and the mismatch is discovered by a
 * person clicking. `navigation.test.ts` walks this table and asserts a
 * `page.tsx` exists for every `href`, which turns the criterion into a gate.
 *
 * That is also why **this table grows only as pages land.** An entry added
 * before its page exists fails the build, so the table can never advertise a
 * destination the app does not have. The alternative — writing the whole of
 * Phase 7's nav up front and letting the test stay red until the pages caught
 * up — would leave the one signal that matters indistinguishable from a
 * regression for days at a time.
 *
 * ## Why the labels are a `Record` and not a map built at runtime
 *
 * `PERMISSION_LABELS` is typed `Record<Permission, string>`, so `tsc` refuses
 * to compile the moment a permission exists without a sentence. That matters
 * more than it looks: `Permission` is mirrored from
 * `backend/src/utils/permissions.ts`, so the chain is a new permission in the
 * backend, a mirrored union member here, and then a compile error until someone
 * writes what it actually lets a person do. Nothing reaches `/staff` or
 * `/settings` unlabelled, and the failure lands in the type check rather than
 * as an empty cell in front of the owner.
 *
 * The sentences describe what a person can *do*, not the permission's name in
 * nicer words. "Void a completed sale" tells an owner what they are granting;
 * "Sales void" tells them nothing they did not already know.
 */

import type { Permission, UserRole } from './auth-session';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLE_LABELS: Record<UserRole, string> = {
  pharmacy_owner: 'Owner',
  pharmacist: 'Pharmacist',
  staff: 'Counter staff',
};

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * What each permission lets a person do, for `/staff` and `/settings`.
 *
 * Exhaustive by type, not by test: a permission added to the union and not
 * labelled here is a compile error. `navigation.test.ts` checks the sentences
 * are usable — non-empty, not the permission name restated — because a `Record`
 * can be satisfied by `'sales:void'` copied into the value and that would
 * compile.
 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'sales:create': 'Ring up a sale at the till',
  'sales:read': 'See sales history and receipts',
  'sales:void': 'Void a completed sale',
  'payments:add': 'Record a cash or mobile-money payment',
  'payments:verify': 'Confirm a mobile-money payment arrived',
  'inventory:read': 'See stock levels and batches',
  'inventory:receive': 'Receive stock into a batch',
  'inventory:adjust': 'Correct a stock count',
  'inventory:write_off': 'Write off expired or damaged stock',
  'inventory:product:write': 'Add and edit products',
  'inventory:import': 'Import products and stock from a CSV',
  'inventory:recall:read': 'Trace a batch to the sales it went into',
  'inventory:alerts:scan': 'Rescan for expiry and low-stock alerts',
  'reports:read': 'See sales, profitability and VAT reports',
  'staff:manage': 'Add, edit and deactivate staff accounts',
  'tax:read': 'See the VAT, NHIL and GETFund rates',
  'tax:change': 'Change the tax rates and the pricing mode',
  'patients:read': 'See patient records',
  'patients:write': 'Add and edit patient records',
  'screenings:write': 'Record a blood-pressure or glucose screening',
  'consultations:write': 'Record a consultation',
  'prescriptions:approve': 'Approve a prescription-only sale',
  'notifications:read': 'See reminders and stock alerts',
  // Worded as the thing it does rather than as "refresh notifications", because
  // the button it gates is the one a pharmacist presses when a patient is standing
  // there and the quarter-hourly scheduler has not run yet. Naming the wait is
  // what tells the owner what they are granting: the right to not wait.
  'notifications:refresh': 'Run the reminder check now instead of waiting for the scheduler',
};

/**
 * The label for a permission the server sent but this build does not know.
 *
 * Needed because `AuthSessionState.permissions` is `readonly string[]`, not
 * `Permission[]` — the server decides the list, and a backend deployed ahead of
 * the frontend will send names this file has never heard of. Showing the raw
 * name beats showing nothing: an owner reading `/staff` who sees a blank line
 * cannot tell an unknown permission from no permission, and the raw name at
 * least says which of those it is.
 */
export function permissionLabel(permission: string): string {
  return (PERMISSION_LABELS as Record<string, string | undefined>)[permission] ?? permission;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export type NavGroup = 'counter' | 'care' | 'stock' | 'office';

export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  counter: 'At the counter',
  care: 'Patient care',
  stock: 'Stock',
  office: 'Back office',
};

/** The order groups are rendered in, which is the order they are read in. */
const NAV_GROUP_ORDER: readonly NavGroup[] = ['counter', 'care', 'stock', 'office'];

export interface NavItem {
  /** Absolute, and required to have a `page.tsx`. Enforced by the test. */
  href: string;
  label: string;
  group: NavGroup;
  /**
   * The permission that gates the destination.
   *
   * Absent means "anyone signed in", and nothing in this table uses that: every
   * page here reads or writes something a permission already names. Gating the
   * nav is not authorisation — the route guards and the API do that, and
   * `backend/src/utils/permissions.ts` says plainly that hiding a button is not
   * authorisation. This only stops the shell offering a cashier a link that
   * would answer 403, which is a worse experience than not showing it.
   */
  permission?: Permission;
}

/**
 * Every destination this build has a page for.
 *
 * Deliberately shorter than the plan's page list: an entry is added when its page
 * exists and not before, because the test would fail and because a nav item for a
 * page nobody built is a dead link wearing a label. Phase 8's `/patients`,
 * `/screenings`, `/consultations` and `/notifications` are here now that their
 * pages have landed; `/sync` arrived with Phase 9.
 *
 * `/sync` sits in the counter group and is gated `sales:create`, the same
 * permission as the till, because the person holding an unsent sale is the person
 * who rang it up. Sending it somewhere an owner would have to find first is how a
 * refused sale goes unnoticed at the end of a shift.
 *
 * The three care destinations are all gated `patients:read` and not a narrower
 * per-page permission, because that is what the backend asks for: `GET /screenings`
 * and `GET /consultations` are both `authorize('patients:read')`. A nav item gated
 * on anything narrower would hide a page from somebody the API would happily
 * serve. The writes those two pages do not carry live behind `screenings:write`
 * and `consultations:write`, on the patient's own record.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/pos', label: 'Till', group: 'counter', permission: 'sales:create' },
  { href: '/sales', label: 'Sales', group: 'counter', permission: 'sales:read' },
  { href: '/sync', label: 'Sync', group: 'counter', permission: 'sales:create' },
  { href: '/patients', label: 'Patients', group: 'care', permission: 'patients:read' },
  { href: '/screenings', label: 'Screenings', group: 'care', permission: 'patients:read' },
  { href: '/consultations', label: 'Consultations', group: 'care', permission: 'patients:read' },
  { href: '/inventory', label: 'Inventory', group: 'stock', permission: 'inventory:read' },
  { href: '/reports', label: 'Reports', group: 'office', permission: 'reports:read' },
  {
    href: '/notifications',
    label: 'Notifications',
    group: 'office',
    permission: 'notifications:read',
  },
  { href: '/staff', label: 'Staff', group: 'office', permission: 'staff:manage' },
  { href: '/settings', label: 'Settings', group: 'office', permission: 'tax:read' },
];

/**
 * Where a signed-in person lands.
 *
 * The till rather than a dashboard, because that is what the person at the
 * counter is walking towards the tablet for, and because a dashboard of figures
 * is a page somebody looks at once and a till is a page somebody looks at four
 * hundred times a day. `/` redirects here.
 */
export const LANDING_HREF = '/pos';

export interface NavSection {
  group: NavGroup;
  label: string;
  items: NavItem[];
}

/**
 * The nav this person sees, grouped, with empty groups dropped.
 *
 * Takes `readonly string[]` rather than `Permission[]` because that is what the
 * session holds — the server decides the list, so the frontend must not assume
 * every string it is given is a name it knows.
 */
export function navFor(permissions: readonly string[]): NavSection[] {
  const sections: NavSection[] = [];

  for (const group of NAV_GROUP_ORDER) {
    const items = NAV_ITEMS.filter(
      (item) => item.group === group && (item.permission === undefined || permissions.includes(item.permission))
    );
    if (items.length > 0) {
      sections.push({ group, label: NAV_GROUP_LABELS[group], items: [...items] });
    }
  }

  return sections;
}

/**
 * Whether this person may open a destination at all.
 *
 * Used by the route guard, so the guard and the shell answer from the same
 * table. A guard with its own list of hrefs is a second copy of this file and
 * will disagree with it the first time an item is added to one and not the
 * other.
 */
export function mayVisit(href: string, permissions: readonly string[]): boolean {
  const item = NAV_ITEMS.find((candidate) => candidate.href === href);
  // Not in the table: nothing here says who may visit, so the guard lets it
  // through and the API answers. Refusing an unlisted href would turn every new
  // page into a blank screen until someone remembered this file.
  if (item === undefined) {
    return true;
  }
  return item.permission === undefined || permissions.includes(item.permission);
}
