'use client';

import { useEffect } from 'react';
import { getAuthSession } from '@/lib/auth-session';

/**
 * Restores a persisted session once, when the app first mounts.
 *
 * A component rather than a call at module scope, for the same reason
 * `getAuthSession()` builds on first use: importing this must not read browser
 * storage or start a request.
 *
 * Mounted in the root layout ahead of the page, so its effect runs before any
 * guard's. The order matters less than it looks, because the store already
 * reports `'restoring'` from construction when a token is persisted — a guard
 * that runs first still waits rather than redirecting.
 */

/**
 * Whether a restore has been started.
 *
 * Module scope, not a ref: `reactStrictMode` is on, so in development every
 * effect runs, cleans up and runs again. Without this the pair of runs would
 * call `/auth/refresh` and `/auth/me` twice on every page load. The refresh is
 * coalesced, so it would still be one renewal — but `/auth/me` would go twice,
 * and more importantly the habit of letting a mount effect fire a write-shaped
 * request twice is what eventually burns the ten-per-quarter-hour allowance the
 * counter needs in order to sign in at all.
 */
let restoreStarted = false;

/** Lets a test observe the once-only behaviour. The app never calls it. */
export function resetSessionBootstrap(): void {
  restoreStarted = false;
}

export function SessionBootstrap() {
  useEffect(() => {
    if (restoreStarted) return;
    restoreStarted = true;
    // `restore()` is written never to reject: it answers `false` for a session
    // that could not be renewed and records why in `signedOutReason`. So there
    // is nothing to catch here, and adding a `.catch` that swallowed would hide
    // the day that contract breaks.
    void getAuthSession().restore();
  }, []);

  return null;
}
