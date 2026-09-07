/**
 * The guard's decision, without a router.
 *
 * The first test is the one that matters and it is written against every
 * destination rather than one, because the bug it guards is a redirect during
 * `'restoring'` and that bug does not care which page it happens on. A suite
 * that checked only `/pos` would pass while `/inventory` sent a cashier to the
 * sign-in page on every load — and the consequence is not a broken screen but a
 * shared rate-limit bucket, since `POST /auth/login` allows ten attempts per
 * quarter hour per IP and a pharmacy behind one router puts every tablet on the
 * same IP.
 */

import { LANDING_HREF, NAV_ITEMS, PERMISSION_LABELS } from '../navigation';
import { LOGIN_HREF, guardDecision, loginDecision, sectionHref } from '../route-guard';
import type { GuardDecision } from '../route-guard';
import { permissionsFor } from '../../test/backend-roles';

/**
 * What counter staff hold, read from `STAFF` in the backend rather than copied.
 *
 * A typed-out list here would be a third copy of the role map and would go
 * stale silently: a permission added to the backend leaves the copy behind, the
 * tests keep passing against yesterday's roles, and the thing that eventually
 * breaks is the till. `src/test/backend-roles.ts` derives the pharmacist by
 * reproducing the backend's own subtraction, which is why it is not a list
 * either.
 */
const STAFF_PERMISSIONS: readonly string[] = permissionsFor('staff');

const PHARMACIST_PERMISSIONS: readonly string[] = permissionsFor('pharmacist');

function decide(
  status: 'signed-out' | 'restoring' | 'signed-in',
  permissions: readonly string[],
  pathname: string
): GuardDecision {
  return guardDecision({ status, permissions, pathname });
}

describe('reducing a pathname to its section', () => {
  it('takes the first segment, so a child inherits its parent gate', () => {
    expect(sectionHref('/sales')).toBe('/sales');
    expect(sectionHref('/sales/6f1c2d90-1a2b-4c3d-8e4f-0a1b2c3d4e5f')).toBe('/sales');
    expect(sectionHref('/inventory/recall/LOT-9')).toBe('/inventory');
  });

  it('answers / for the root, and ignores a trailing slash', () => {
    expect(sectionHref('/')).toBe('/');
    expect(sectionHref('/pos/')).toBe('/pos');
  });

  it('gates a nested route the table has never heard of', () => {
    // The receipt page does not exist yet. When it does, a role without
    // `sales:read` must not reach it by knowing the URL — and gating on the whole
    // pathname would let them, because `mayVisit` waves through anything the
    // table does not mention.
    expect(decide('signed-in', permissionsFor('pharmacist'), '/sales/any-id')).toEqual({
      action: 'render',
    });
    const noSalesRead = permissionsFor('staff').filter((permission) => permission !== 'sales:read');
    expect(decide('signed-in', noSalesRead, '/sales/any-id').action).toBe('refuse');
    expect(decide('signed-in', noSalesRead, '/sales').action).toBe('refuse');
  });
});

describe('while the session is being restored', () => {
  it('waits on every destination, and never redirects', () => {
    // No permissions at all, and still `wait` — not `refuse`, and not
    // `redirect`. The restore is about to answer both questions, and answering
    // either of them from an empty list is the mistake.
    for (const item of NAV_ITEMS) {
      expect({ href: item.href, decision: decide('restoring', [], item.href) }).toEqual({
        href: item.href,
        decision: { action: 'wait' },
      });
    }
  });

  it('waits even on a page this person will never be allowed to open', () => {
    // A pharmacist restoring, pointed at `/staff`. The temptation is to check
    // the permission first, because that answer is already known — and doing so
    // shows a refusal for a moment before the restore finishes and the page
    // renders, which reads as the app changing its mind.
    expect(decide('restoring', PHARMACIST_PERMISSIONS, '/staff')).toEqual({ action: 'wait' });
  });
});

describe('with nobody signed in', () => {
  it('sends the person to the sign-in page', () => {
    expect(decide('signed-out', [], '/pos')).toEqual({ action: 'redirect', to: LOGIN_HREF });
  });

  it('carries no return address', () => {
    const decision = decide('signed-out', [], '/inventory');
    // A `?next=` is an open redirect unless it is validated against this app's
    // own routes. Asserted on the whole object rather than on one field, so
    // adding a `next` key fails here instead of shipping.
    expect(Object.keys(decision).sort()).toEqual(['action', 'to']);
  });

  it('does not leak the permissions it was given', () => {
    // A signed-out store can still be holding a stale list. The redirect target
    // must not vary with it, or two people at the same till land in different
    // places depending on who signed in last.
    expect(decide('signed-out', PHARMACIST_PERMISSIONS, '/reports')).toEqual({
      action: 'redirect',
      to: LOGIN_HREF,
    });
  });
});

describe('signed in and allowed', () => {
  it('renders the till for counter staff', () => {
    expect(decide('signed-in', STAFF_PERMISSIONS, '/pos')).toEqual({ action: 'render' });
  });

  it('renders reports for a pharmacist, who holds reports:read', () => {
    expect(decide('signed-in', PHARMACIST_PERMISSIONS, '/reports')).toEqual({ action: 'render' });
  });

  it('renders a route the table does not mention', () => {
    // The API guards the data. Refusing an unlisted href would blank every new
    // page until somebody remembered `navigation.ts`, and would do it silently.
    expect(decide('signed-in', [], '/a-page-nobody-listed')).toEqual({ action: 'render' });
  });

  it('renders settings for counter staff, who may read the rates', () => {
    // `tax:read` is in `STAFF` because a till cannot price a basket without the
    // rates. It is not a mistake to be corrected: the split is that `tax:change`
    // is owner-only.
    expect(decide('signed-in', STAFF_PERMISSIONS, '/settings')).toEqual({ action: 'render' });
  });
});

describe('signed in and not allowed', () => {
  it('refuses reports to counter staff', () => {
    const decision = decide('signed-in', STAFF_PERMISSIONS, '/reports');
    expect(decision.action).toBe('refuse');
  });

  it('names the page and what the account lacks, in words', () => {
    const decision = decide('signed-in', STAFF_PERMISSIONS, '/reports');
    if (decision.action !== 'refuse') {
      throw new Error('expected a refusal');
    }
    expect(decision.message).toBe('You cannot open Reports.');
    // The label, not `reports:read`. A cashier cannot act on a permission name,
    // and the owner reading the message needs the sentence to know what was
    // asked for.
    expect(decision.detail).toContain(PERMISSION_LABELS['reports:read']);
    expect(decision.detail).not.toContain('reports:read');
  });

  it('says who can change it, because a refusal with no next step is a dead end', () => {
    const decision = decide('signed-in', STAFF_PERMISSIONS, '/staff');
    if (decision.action !== 'refuse') {
      throw new Error('expected a refusal');
    }
    // `staff:manage` is owner-only, so the answer is the same for every gated
    // page and can be stated rather than guessed at.
    expect(decision.detail).toContain('Only the owner can change what your account may do.');
  });

  it('refuses staff management to a pharmacist, who runs the dispensary without it', () => {
    // A pharmacist holds everything except the five the brief makes owner-only,
    // and `staff:manage` is one of them: running the shop in the owner's absence
    // must not include handing out accounts, including to themselves.
    expect(decide('signed-in', PHARMACIST_PERMISSIONS, '/staff').action).toBe('refuse');
  });

  it('refuses rather than rendering a page whose data would 403', () => {
    // Not a substitute for the API's own check — it is the reason the shell does
    // not offer the link either. Both come from one table, which the agreement
    // test below pins.
    for (const item of NAV_ITEMS) {
      const decision = decide('signed-in', STAFF_PERMISSIONS, item.href);
      expect(['render', 'refuse']).toContain(decision.action);
    }
  });
});

describe('the guard and the shell read one table', () => {
  it('renders exactly the destinations the shell links to', () => {
    for (const permissions of [[], STAFF_PERMISSIONS, PHARMACIST_PERMISSIONS]) {
      const linked = new Set(NAV_ITEMS.filter((item) => item.permission !== undefined && permissions.includes(item.permission)).map((item) => item.href));
      for (const item of NAV_ITEMS) {
        const decision = decide('signed-in', permissions, item.href);
        // A link that renders and then refuses is worse than either on its own:
        // the cashier taps it and gets an error, and has to ask whether the till
        // is broken.
        expect({ href: item.href, renders: decision.action === 'render' }).toEqual({
          href: item.href,
          renders: linked.has(item.href),
        });
      }
    }
  });

  it('points its redirect at a page that exists in the table or is the login', () => {
    // `LANDING_HREF` is where `/login` sends somebody already signed in, and
    // `/` sends everybody. If it ever stopped being a real page the app would
    // open on a 404 for every signed-in person, from a redirect that looks
    // correct in the code.
    expect(LOGIN_HREF).toBe('/login');
    expect(NAV_ITEMS.some((item) => item.href === LANDING_HREF)).toBe(true);
  });
});

describe('the sign-in page', () => {
  it('waits while restoring, so the form does not flash past', () => {
    expect(loginDecision('restoring')).toEqual({ action: 'wait' });
  });

  it('sends somebody already signed in to the till', () => {
    expect(loginDecision('signed-in')).toEqual({ action: 'redirect', to: LANDING_HREF });
  });

  it('renders the form when nobody is signed in', () => {
    expect(loginDecision('signed-out')).toEqual({ action: 'render' });
  });

  it('does not send a signed-in person back to the page they were refused', () => {
    // The landing page is the till, which every role holds. Sending them to the
    // href they came from would loop: refused at `/reports`, sign in, back to
    // `/reports`, refused again.
    expect(loginDecision('signed-in')).not.toEqual({ action: 'redirect', to: LOGIN_HREF });
  });
});
