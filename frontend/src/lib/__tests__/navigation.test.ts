/**
 * The navigation table, checked against the filesystem.
 *
 * The load-bearing test here is the one that walks `src/app`: it is the
 * automatable half of the plan's acceptance criterion that *every nav item
 * resolves to a real page* and there are *no dead links*. Without it the table
 * and the router are two facts with nothing comparing them, and the mismatch is
 * found by a person tapping a link in front of a customer.
 *
 * The route derivation has to understand Next's route groups, because
 * `src/app/(app)/pos/page.tsx` serves `/pos` — the parenthesised directory is
 * layout-only and contributes nothing to the URL. Comparing hrefs to raw
 * directory names would report every page as missing.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import {
  LANDING_HREF,
  NAV_GROUP_LABELS,
  NAV_ITEMS,
  PERMISSION_LABELS,
  ROLE_LABELS,
  mayVisit,
  navFor,
  permissionLabel,
} from '../navigation';
import type { NavGroup } from '../navigation';
import { USER_ROLES } from '../auth-session';
import { allPermissions, permissionsFor } from '../../test/backend-roles';

const APP_DIR = join(__dirname, '..', '..', 'app');

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else {
      found.push(full);
    }
  }
  return found;
}

/**
 * Every route this app serves, derived from the files on disk.
 *
 * Route groups — any `(name)` segment — are dropped, because Next does. A
 * directory's `page.tsx` becomes that directory's path, and the one at the root
 * becomes `/`.
 */
function routesOnDisk(): Set<string> {
  const routes = new Set<string>();

  for (const file of walk(APP_DIR)) {
    const normalised = file.split(sep).join('/');
    if (!normalised.endsWith('/page.tsx')) {
      continue;
    }
    const relative = normalised.slice(normalised.indexOf('/app/') + '/app/'.length);
    const withoutPage = relative.slice(0, -'/page.tsx'.length);
    const segments = withoutPage.split('/').filter((segment) => segment.length > 0);
    // `(app)` and every other route group contributes nothing to the URL.
    const real = segments.filter((segment) => !segment.startsWith('('));
    routes.add(real.length === 0 ? '/' : `/${real.join('/')}`);
  }

  return routes;
}

describe('every destination is a real page', () => {
  it('has a page.tsx for each href in the table', () => {
    const routes = routesOnDisk();
    const dead = NAV_ITEMS.filter((item) => !routes.has(item.href)).map((item) => item.href);

    // Collected and reported whole, so one run names every dead link rather than
    // the first. A nav with six entries and four missing pages is one edit, not
    // four test runs.
    expect(dead).toEqual([]);
  });

  it('has no duplicate hrefs, which would render two links to one page', () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('routes the landing page somewhere in the table', () => {
    // `/` redirects here, so a landing href with no page is a redirect into a
    // 404 — and it would be the first thing anybody saw after signing in.
    expect(NAV_ITEMS.some((item) => item.href === LANDING_HREF)).toBe(true);
  });

  it('has no /register and no /subscription, anywhere', () => {
    // The plan is explicit that these two do not exist: this is a single-tenant
    // build for one pharmacy, so there is nobody to register and nothing to
    // subscribe to. Checked on disk as well as in the table, because a page with
    // no link to it is still a page, and `/register` on a single-tenant app is a
    // way to create an account nobody authorised.
    const routes = routesOnDisk();
    expect(routes.has('/register')).toBe(false);
    expect(routes.has('/subscription')).toBe(false);
    expect(NAV_ITEMS.some((item) => item.href === '/register')).toBe(false);
    expect(NAV_ITEMS.some((item) => item.href === '/subscription')).toBe(false);
  });

  it('names a group that has a label', () => {
    const unlabelled = NAV_ITEMS.filter((item) => !(item.group in NAV_GROUP_LABELS));
    expect(unlabelled).toEqual([]);
  });
});

describe('what each role is offered', () => {
  it('offers every role something, so nobody signs into a blank shell', () => {
    for (const role of USER_ROLES) {
      const sections = navFor(permissionsFor(role));
      const count = sections.reduce((total, section) => total + section.items.length, 0);
      expect({ role, count }).toEqual({ role, count: expect.any(Number) });
      expect(count).toBeGreaterThan(0);
    }
  });

  it('keeps reports and staff management away from counter staff', () => {
    const hrefs = navFor(permissionsFor('staff'))
      .flatMap((section) => section.items)
      .map((item) => item.href);

    // Neither is in `STAFF`, and a link that answers 403 is worse than no link:
    // the cashier taps it, gets an error, and has to ask whether the till is
    // broken. `reports:read` also covers profitability, which is cost data.
    expect(hrefs).not.toContain('/reports');
    expect(hrefs).not.toContain('/staff');
    expect(hrefs).toContain('/pos');
    expect(hrefs).toContain('/sales');
  });

  it('offers the owner every destination', () => {
    const hrefs = navFor(permissionsFor('pharmacy_owner')).flatMap((section) =>
      section.items.map((item) => item.href)
    );
    expect(hrefs.sort()).toEqual([...NAV_ITEMS.map((item) => item.href)].sort());
  });

  it('drops a group with nothing in it rather than rendering an empty heading', () => {
    const sections = navFor(['sales:create', 'sales:read']);
    expect(sections.map((section) => section.group)).toEqual(['counter']);
  });

  it('groups in reading order, counter first', () => {
    const sections = navFor(allPermissions());
    // `care` sits between the counter and stock: the till, then the patients, then
    // the shelves. `allPermissions()` holds every gate, so all four groups have an
    // item and all four render.
    expect(sections.map((section) => section.group)).toEqual([
      'counter',
      'care',
      'stock',
      'office',
    ]);
  });
});

describe('the route guard agrees with the table', () => {
  it('refuses a gated page to somebody without the permission', () => {
    expect(mayVisit('/reports', ['sales:create'])).toBe(false);
    expect(mayVisit('/reports', ['reports:read'])).toBe(true);
  });

  it('lets an unlisted href through, because nothing here says who may visit', () => {
    // Refusing an unlisted href would turn every new page into a blank screen
    // until somebody remembered this file — and the API still guards the data,
    // so the guard is not the thing standing between a cashier and anything.
    expect(mayVisit('/some-page-not-in-the-table', [])).toBe(true);
  });

  it('never contradicts navFor', () => {
    // The guard and the shell read one table. Two lists would disagree the first
    // time an item was added to one and not the other, and the symptom would be
    // a link that renders and then refuses, or a page that works and is
    // unreachable.
    for (const permissions of [[], ['sales:create'], allPermissions()]) {
      const visible = new Set(navFor(permissions).flatMap((section) => section.items.map((item) => item.href)));
      for (const item of NAV_ITEMS) {
        expect({ href: item.href, mayVisit: mayVisit(item.href, permissions) }).toEqual({
          href: item.href,
          mayVisit: visible.has(item.href),
        });
      }
    }
  });
});

describe('the permission labels', () => {
  it('labels every permission the backend declares', () => {
    const declared = allPermissions();
    const labelled = Object.keys(PERMISSION_LABELS);

    // Both directions. A label with no permission behind it is dead weight that
    // will be copied; a permission with no label renders as its own raw name in
    // front of the owner, which is what `permissionLabel` falls back to.
    expect({ missing: declared.filter((name) => !labelled.includes(name)) }).toEqual({ missing: [] });
    expect({ stale: labelled.filter((name) => !declared.includes(name)) }).toEqual({ stale: [] });
  });

  it('writes a sentence, not the permission name in nicer words', () => {
    const problems: string[] = [];
    for (const [permission, label] of Object.entries(PERMISSION_LABELS)) {
      if (label.trim().length === 0) {
        problems.push(`${permission}: empty`);
      }
      // A `Record<Permission, string>` is satisfied by copying the key into the
      // value, and that compiles. "Sales void" is not a sentence an owner can
      // act on; "Void a completed sale" says what is being granted.
      if (label.toLowerCase() === permission.replace(/[:_]/g, ' ').toLowerCase()) {
        problems.push(`${permission}: label restates the name`);
      }
      if (!/^[A-Z]/.test(label)) {
        problems.push(`${permission}: not capitalised`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('falls back to the raw name for a permission this build has not heard of', () => {
    // The backend can be deployed ahead of the frontend, and the session holds
    // `readonly string[]` for exactly that reason. A blank cell would be worse:
    // an owner reading `/staff` could not tell an unknown permission from no
    // permission at all.
    expect(permissionLabel('sales:create')).toBe(PERMISSION_LABELS['sales:create']);
    expect(permissionLabel('something:new')).toBe('something:new');
  });

  it('labels every role', () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...USER_ROLES].sort());
    for (const role of USER_ROLES) {
      expect(ROLE_LABELS[role].length).toBeGreaterThan(0);
    }
  });

  it('keeps the counter staff label away from the word staff alone', () => {
    // "Staff" on its own is the name of the page a staff member cannot open, and
    // the role that cannot open it. Naming the role "Counter staff" is what keeps
    // the two apart in a dropdown.
    expect(ROLE_LABELS.staff).toBe('Counter staff');
  });
});

describe('the groups', () => {
  it('puts every item in a group that is declared', () => {
    const declared = Object.keys(NAV_GROUP_LABELS) as NavGroup[];
    for (const item of NAV_ITEMS) {
      expect(declared).toContain(item.group);
    }
  });
});
