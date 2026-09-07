/**
 * What a route guard should do, decided without a router.
 *
 * The component that applies this is eleven lines and cannot be got wrong in an
 * interesting way; the decision can. So the decision is a pure function here,
 * and `route-guard.test.ts` covers it without mocking `next/navigation`, a
 * store, or an API — which is the split `frontend/jest.config.js` asks for:
 * pure logic tested, page rendering left to `next build` and the type checker.
 *
 * ## The mistake this exists to prevent
 *
 * Redirecting while the session is still `'restoring'`. That is the natural
 * thing to write — `if (status !== 'signed-in') go to /login` — and it is
 * wrong in a way that only shows up in the field. A cashier who left a valid
 * refresh token in the tablet opens the till, the guard sees `'signed-out'`
 * before the restore finishes, and sends them to the sign-in page. They sign in.
 * It works. Everybody reports the till is fine.
 *
 * What has actually happened is that the persisted session is never used, so
 * every person signs in on every shift. `POST /auth/login` is rate limited to
 * ten attempts per quarter hour **per IP**, and a pharmacy behind one router
 * puts every tablet on the same IP. Six staff signing in twice a morning is
 * twelve requests, and the thirteenth — the owner, at the till, with a queue —
 * is told to wait fifteen minutes. Waiting is the correct behaviour for a
 * state that is about to be answered, and it costs one spinner.
 */

import { LANDING_HREF, NAV_ITEMS, mayVisit, permissionLabel } from './navigation';
import type { Permission } from './auth-session';
import type { SessionStatus } from './auth-session';

/** The sign-in page. Not in `NAV_ITEMS`: it renders outside the app shell. */
export const LOGIN_HREF = '/login';

export type GuardDecision =
  /** The restore is in flight. Render a spinner and do not navigate. */
  | { action: 'wait' }
  /** Nobody is signed in. */
  | { action: 'redirect'; to: string }
  /** Signed in, and this destination is not theirs. */
  | { action: 'refuse'; message: string; detail: string }
  /** Signed in and allowed. Render the page. */
  | { action: 'render' };

/**
 * Why a refusal names what the account lacks, rather than saying "forbidden".
 *
 * Only the owner can change what an account may do: granting a permission means
 * editing a staff record, and `staff:manage` is one of the five the brief makes
 * owner-only. So the person to ask is always the same, and saying so turns a
 * dead end into the next step. The same reasoning applies at the till to
 * `payments:verify`, which counter staff do not hold — the UI has to name a
 * person rather than show a 403.
 */
const ASK_THE_OWNER = 'Only the owner can change what your account may do.';

function refusalFor(href: string): { message: string; detail: string } {
  const item = NAV_ITEMS.find((candidate) => candidate.href === href);
  const permission: Permission | undefined = item?.permission;
  const label = item?.label ?? href;

  if (permission === undefined) {
    // `NavItem.permission` is optional, so the type system requires this branch
    // even though no ungated entry can reach it: `mayVisit` answers yes for an
    // item with no permission, and yes for an href the table does not mention.
    // It is here for the day an entry gains a gate this function does not know
    // about, and a refusal with no reason is the thing this module exists to
    // avoid.
    return { message: `You cannot open ${label}.`, detail: ASK_THE_OWNER };
  }

  return {
    message: `You cannot open ${label}.`,
    // The label, not the permission name: "See sales, profitability and VAT
    // reports" tells a pharmacist what they are missing, and `reports:read`
    // tells them what to type into a message to the owner.
    detail: `Your account does not include "${permissionLabel(permission)}". ${ASK_THE_OWNER}`,
  };
}

/**
 * The nav entry a pathname falls under: `/sales/12` is `/sales`.
 *
 * Gating on the whole pathname would leave every nested route open. A receipt at
 * `/sales/<id>` is not in `NAV_ITEMS`, and `mayVisit` answers yes for an href the
 * table does not mention — which is correct for a page nobody thought about and
 * wrong for a page deliberately hung under a gated section. Taking the first
 * segment means the child inherits its parent's gate, so adding `/sales/[id]`
 * later cannot quietly put sale history in front of a role that lacks
 * `sales:read`.
 */
export function sectionHref(pathname: string): string {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  return segments.length === 0 ? '/' : `/${segments[0] ?? ''}`;
}

/**
 * The decision for a page inside the app shell.
 *
 * `pathname` is the real URL from `usePathname()`, reduced to its section before
 * the gate is looked up. The gate comes from `NAV_ITEMS` through the same
 * `mayVisit` the shell uses, deliberately not through a second list here: a guard
 * with its own list of hrefs is a copy of the table, and the two disagree the
 * first time an entry is added to one and not the other — the symptom being a
 * link that renders and then refuses, or a page that works and cannot be
 * reached.
 */
export function guardDecision(input: {
  status: SessionStatus;
  permissions: readonly string[];
  pathname: string;
}): GuardDecision {
  if (input.status === 'restoring') {
    return { action: 'wait' };
  }
  if (input.status === 'signed-out') {
    // Plainly `/login`, with no `?next=` carrying the pathname back. A `next`
    // parameter is an open redirect unless it is validated against a list of
    // this app's own routes, and the thing it buys here is small: the till is
    // where everybody was going anyway, so signing in lands on `LANDING_HREF`.
    return { action: 'redirect', to: LOGIN_HREF };
  }
  const section = sectionHref(input.pathname);
  if (!mayVisit(section, input.permissions)) {
    return { action: 'refuse', ...refusalFor(section) };
  }
  return { action: 'render' };
}

/**
 * The decision for the sign-in page itself.
 *
 * Somebody already signed in who reaches `/login` is sent to the till rather
 * than shown a form. Not redirected while `'restoring'`, for the same reason as
 * above — though here the cost of getting it wrong is only a form flashing past.
 */
export function loginDecision(status: SessionStatus): GuardDecision {
  if (status === 'restoring') {
    return { action: 'wait' };
  }
  if (status === 'signed-in') {
    return { action: 'redirect', to: LANDING_HREF };
  }
  return { action: 'render' };
}
