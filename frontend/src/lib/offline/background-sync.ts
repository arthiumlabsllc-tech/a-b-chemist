/**
 * Asking the browser to wake this tab when the connection can carry the queue.
 *
 * The other half of the handshake in `public/sw.js`: the worker listens for a
 * `sync` event and, when it fires, tells every open tab. It cannot decide to do
 * that on its own — background sync is a registration the *page* makes, and the
 * browser only fires the event for a tag something asked for. Without this module
 * the worker's listener is dead code and the queue waits for the operator to look
 * at the screen.
 *
 * ## Why the tab needs waking at all
 *
 * A till spends most of its life in a background tab between customers. Chrome
 * throttles timers there and discards the tab entirely under memory pressure, and
 * a discarded tab fires nothing until it is reloaded. `online` is not throttled,
 * so a tab merely hidden still recovers by itself — but a discarded one does not,
 * and that is a drawer holding cash for sales no report knows about until somebody
 * notices. Background sync is not throttled and not discarded with the tab, which
 * is the whole reason to use it.
 *
 * ## What this module never does
 *
 * It never replays a sale. The queue is in the page's IndexedDB and the tokens
 * that authorise a write are in the page's memory, so the replay belongs to
 * `flushQueue` and stays there; `sw.js` says the same about itself from the other
 * side. All that happens here is a registration, and all that comes back is a
 * message.
 */

/**
 * The tag, and the message type the worker posts back.
 *
 * One string with three readers: this module registers it, `public/sw.js` matches
 * the `sync` event against it and posts it as `type`, and `offline-sync.tsx`
 * matches the incoming message against it. The worker is plain JavaScript in
 * `public/` and cannot import from here, so the two files hold the literal
 * separately — `background-sync.mirror.test.ts` reads `sw.js` and fails if they
 * ever part company, because a mismatch is silent: the worker registers nothing,
 * fires nothing, and every test in this file still passes.
 */
export const BACKGROUND_SYNC_TAG = 'ab-chemist-sync';

/**
 * The slice of a registration background sync adds.
 *
 * Declared rather than taken from `lib.dom`: `BackgroundSyncManager` was never
 * standardised past a draft, so TypeScript does not know `registration.sync`
 * exists. Reaching through a cast to `any` would compile and would also hide a
 * misspelt `register`, which is a wake-up path that quietly never arms.
 */
export interface SyncManager {
  register(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}

export interface SyncRegistration {
  /** Absent on Safari and Firefox, which have never shipped background sync. */
  readonly sync?: SyncManager;
}

/** The seam. A fake for tests; `browserBackgroundSync` for the app. */
export interface BackgroundSyncPort {
  /** The registration whose worker is live, or null when there is none to ask. */
  registration(): Promise<SyncRegistration | null>;
}

/**
 * What one attempt ended in.
 *
 * - `armed` — the browser took the tag and will fire the event when it believes
 *   the connection is back.
 * - `idle` — the queue is empty, so there is nothing to wake the tab for.
 * - `unavailable` — no worker, a browser without `sync`, or a registration the
 *   browser refused. Not an error to surface: `offline-sync.tsx` also flushes at
 *   boot and on `online`, so the queue still reconciles, just not from a discarded
 *   tab. Telling a pharmacist their browser does not support background sync is
 *   not a thing they can act on.
 */
export type BackgroundSyncState = 'armed' | 'idle' | 'unavailable';

export interface BackgroundSync {
  /** Arms or stands down to match the queue. Safe to call on every change. */
  reconcile(depth: number): Promise<BackgroundSyncState>;
}

/**
 * The real port.
 *
 * `getRegistration()` rather than `navigator.serviceWorker.ready`, and the
 * difference is a hang: `ready` does not resolve until a worker activates, and if
 * none is ever going to — development, where the registrar does not run, or a
 * registration that failed — every call parks a promise that nothing will settle.
 * Asking whether there is one answers immediately, and a worker still installing
 * is treated as no worker, which costs one missed arming and is retried on the
 * next queue change.
 */
export function browserBackgroundSync(): BackgroundSyncPort {
  return {
    async registration(): Promise<SyncRegistration | null> {
      if (typeof navigator === 'undefined') return null;
      const workers = navigator.serviceWorker;
      if (workers === undefined) return null;
      try {
        const found = await workers.getRegistration();
        if (found === undefined || found.active === null) return null;
        return found as unknown as SyncRegistration;
      } catch {
        return null;
      }
    },
  };
}

export function createBackgroundSync(port: BackgroundSyncPort): BackgroundSync {
  /**
   * Serialized rather than coalesced.
   *
   * A `register` that overlaps the tail of the previous one is harmless — the tag
   * is idempotent — but overlapping calls make `reconcile` answer with a state
   * belonging to a different depth, which is the sort of thing that reads as a
   * flake later. Each call waits for the one before it, so the answer returned is
   * the answer for the depth asked about.
   */
  let chain: Promise<unknown> = Promise.resolve();

  async function run(depth: number): Promise<BackgroundSyncState> {
    if (depth === 0) {
      // Nothing to ask for. There is deliberately no matching `unregister`: the
      // shipped API has `register` and `getTags` and no cancel, and one does not
      // want one here. A wake-up that fires against an empty queue costs nothing
      // — `flushQueue` iterates an empty list and makes no request — so a tag left
      // over from a sale that has since synced is a no-op, not a leak.
      return 'idle';
    }

    const registration = await port.registration();
    const sync = registration?.sync;
    if (sync === undefined) return 'unavailable';

    try {
      await sync.register(BACKGROUND_SYNC_TAG);
      return 'armed';
    } catch {
      // A browser that declines the registration — a user preference, or a quota
      // on pending syncs — leaves the boot and `online` flushes as the paths that
      // reconcile the queue, which is what they were before this existed.
      return 'unavailable';
    }
  }

  return {
    reconcile(depth: number): Promise<BackgroundSyncState> {
      const next = chain.then(() => run(depth));
      // `run` cannot reject, so this catch is only the guarantee that a future
      // edit which lets it throw does not wedge every later arming behind a
      // broken chain.
      chain = next.catch(() => {});
      return next;
    },
  };
}

// --- The app's one instance -------------------------------------------------

let backgroundSync: BackgroundSync | null = null;

/**
 * The instance `offline-sync.tsx` uses.
 *
 * Created on first call, so importing this module during a server render or in a
 * test reaches for no browser API — the rule `getSaleQueue()` and
 * `getAuthSession()` both follow.
 */
export function getBackgroundSync(): BackgroundSync {
  if (backgroundSync === null) {
    backgroundSync = createBackgroundSync(browserBackgroundSync());
  }
  return backgroundSync;
}

/** Drops the singleton. Tests use it; the app never needs to. */
export function resetBackgroundSync(): void {
  backgroundSync = null;
}
