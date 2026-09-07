/**
 * @jest-environment node
 */

import { renderToString } from 'react-dom/server';
import { useAuth } from '../use-auth';

/**
 * The server half of the hook.
 *
 * Run in a node environment rather than in jsdom with `window` deleted, because
 * this is the path production actually takes: Next renders every client
 * component on the server before the browser sees it. Here `window` is genuinely
 * absent instead of removed for the duration of an assertion, and there is no
 * `localStorage` to accidentally read.
 *
 * jsdom cannot host it at all. It provides no `MessageChannel` and no
 * `TextEncoder`, and `react-dom/server` needs both at import time — before any
 * test body runs, so a suite cannot install them itself. Polyfilling
 * `MessageChannel` from `node:worker_threads` was tried and abandoned: its ports
 * hold the event loop open, and React's scheduler then kept every jest worker
 * alive long after the run had finished.
 */

/** Renders the three things a route guard and a nav branch on. */
function StatusProbe() {
  const { status, signedOutReason, permissions, user } = useAuth();
  return <span>{`${status}|${signedOutReason}|${permissions.length}|${user === null}`}</span>;
}

describe('a page rendered on the server', () => {
  it('reports restoring, so a guard does not redirect before the browser checks', () => {
    const html = renderToString(<StatusProbe />);

    // Not 'signed-out'. React renders this tree on the server first, and a guard
    // that read 'signed-out' from that pass would send a cashier who is signed in
    // to the login page before the browser ever looked at the token they
    // persisted. That is every reload, so on a till left open all day it is every
    // morning — and it looks like the tablet has forgotten them, which is the
    // kind of thing that gets reported as "the app keeps logging me out".
    expect(html).toContain('restoring|never|0|true');
    expect(html).not.toContain('signed-out');
  });

  it('does not reach for the session, which would throw and fail every page', () => {
    // `getAuthSession()` throws without a `window`, deliberately: module scope on
    // the server belongs to the process rather than the request, so a session
    // built while rendering would still be sitting there for the next visitor,
    // holding the previous visitor's refresh token.
    //
    // So reaching this assertion at all is most of the test. Were the hook to
    // call `getAuthSession()` during render, this would not be one degraded page
    // — every page using the hook would fail at request time, and only in
    // production, because a jsdom test always has a `window`.
    expect(() => renderToString(<StatusProbe />)).not.toThrow();
  });

  it('hands the page an inert client, and the same one every render', () => {
    const seen: unknown[] = [];

    function ApiProbe() {
      seen.push(useAuth().api);
      return null;
    }

    renderToString(<ApiProbe />);
    renderToString(<ApiProbe />);

    // Inert rather than absent: a page writes `const { api } = useAuth()` at the
    // top of its render and calls it from an effect, so a getter that threw would
    // fail the render while the effect that would have used it never runs at all.
    // This one carries no token and cannot refresh, so anything that did reach it
    // would be refused by the API — the right answer for a request made with no
    // session.
    //
    // And the same one each time, because pages list `api` in their effect
    // dependencies: a fresh client per render would re-run every effect on every
    // render, which presents as a slow API rather than a broken dependency array.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).toBe(seen[1]);
  });
});
