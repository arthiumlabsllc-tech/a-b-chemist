/**
 * Arming the background-sync wake-up.
 *
 * Driven against a fake port rather than a real worker, because the behaviour
 * worth pinning is not "does Chrome accept a tag" — it is the three decisions this
 * module makes around that call: when to ask, when not to, and what to say when
 * the browser will not take it. Each of those is a branch a till in the field
 * depends on and none of them is visible in a browser.
 *
 * The re-arming test is the one to read before changing `reconcile`. It is the
 * difference between a queue that recovers on its own and one that waits for the
 * operator to notice, and it fails silently in production either way.
 */

import {
  BACKGROUND_SYNC_TAG,
  browserBackgroundSync,
  createBackgroundSync,
  getBackgroundSync,
  resetBackgroundSync,
  type BackgroundSyncPort,
  type SyncRegistration,
} from '../background-sync';

/** Lets a queued microtask or a stubbed async port settle before it is asserted on. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A worker that takes tags, or refuses them.
 *
 * `registrationCalls` counts the port, not the tag: whether the module bothers to
 * ask the browser at all is itself under test.
 */
function fakeWorker(options: { refuse?: boolean; absent?: boolean } = {}) {
  const tags: string[] = [];
  let registrationCalls = 0;
  const refusals: string[] = [];

  const registration: SyncRegistration | null = options.absent
    ? null
    : {
        sync: {
          async register(tag: string): Promise<void> {
            if (options.refuse === true) {
              refusals.push(tag);
              throw new Error('The browser declined the registration');
            }
            tags.push(tag);
          },
          async getTags(): Promise<string[]> {
            return [...tags];
          },
        },
      };

  const port: BackgroundSyncPort = {
    async registration(): Promise<SyncRegistration | null> {
      registrationCalls += 1;
      return registration;
    },
  };

  return { port, tags, refusals, registrationCalls: () => registrationCalls };
}

describe('arming the wake-up', () => {
  afterEach(() => {
    resetBackgroundSync();
  });

  it('registers the tag when the queue is holding a sale', async () => {
    const worker = fakeWorker();

    await expect(createBackgroundSync(worker.port).reconcile(1)).resolves.toBe('armed');

    expect(worker.tags).toEqual([BACKGROUND_SYNC_TAG]);
  });

  it('does not ask the browser at all when the queue is empty', async () => {
    const worker = fakeWorker();

    await expect(createBackgroundSync(worker.port).reconcile(0)).resolves.toBe('idle');

    // Not merely "registers nothing": reaching for a service worker registration
    // on every boot and every emptied queue is work with nothing to show for it,
    // and `idle` has to be answerable without a browser being present.
    expect(worker.registrationCalls()).toBe(0);
    expect(worker.tags).toEqual([]);
  });

  it('asks again after a flush that left the sale still queued', async () => {
    const worker = fakeWorker();
    const sync = createBackgroundSync(worker.port);

    await sync.reconcile(1);
    // The browser fired the sync, the flush failed because the server was still
    // down, and the queue is exactly as deep as it was. A one-shot registration
    // was consumed by that firing, so this second call is the only thing that will
    // ever wake the tab again.
    await sync.reconcile(1);

    expect(worker.tags).toEqual([BACKGROUND_SYNC_TAG, BACKGROUND_SYNC_TAG]);
  });

  it('reports no worker as unavailable rather than throwing', async () => {
    const worker = fakeWorker({ absent: true });

    await expect(createBackgroundSync(worker.port).reconcile(3)).resolves.toBe('unavailable');
  });

  it('reports a browser without background sync as unavailable', async () => {
    // Safari and Firefox: a registration with no `sync` on it.
    const port: BackgroundSyncPort = {
      async registration() {
        return {};
      },
    };

    await expect(createBackgroundSync(port).reconcile(1)).resolves.toBe('unavailable');
  });

  it('reports a registration the browser declined as unavailable', async () => {
    const worker = fakeWorker({ refuse: true });

    await expect(createBackgroundSync(worker.port).reconcile(1)).resolves.toBe('unavailable');

    expect(worker.refusals).toEqual([BACKGROUND_SYNC_TAG]);
    expect(worker.tags).toEqual([]);
  });

  it('runs one attempt at a time, so an answer belongs to the depth asked about', async () => {
    let inside = 0;
    let overlapped = false;
    const worker = fakeWorker();
    const port: BackgroundSyncPort = {
      async registration() {
        inside += 1;
        if (inside > 1) overlapped = true;
        await settle();
        inside -= 1;
        return worker.port.registration();
      },
    };

    // One instance, two calls made before the first has answered — the shape a
    // flush produces, since every queue mutation reconciles.
    const sync = createBackgroundSync(port);
    const states = await Promise.all([sync.reconcile(1), sync.reconcile(2)]);

    expect(overlapped).toBe(false);
    expect(states).toEqual(['armed', 'armed']);
  });

  it('keeps arming after one attempt fails', async () => {
    // The chain is the thing that could wedge: if a refused registration left it
    // rejected, every later sale would queue with no wake-up and no way to see why.
    let refused = true;
    const port: BackgroundSyncPort = {
      async registration(): Promise<SyncRegistration | null> {
        return {
          sync: {
            async register(tag: string): Promise<void> {
              if (refused) throw new Error(`declined ${tag}`);
            },
            async getTags(): Promise<string[]> {
              return [];
            },
          },
        };
      },
    };
    const sync = createBackgroundSync(port);

    await expect(sync.reconcile(1)).resolves.toBe('unavailable');
    refused = false;
    await expect(sync.reconcile(1)).resolves.toBe('armed');
  });
});

describe('the app instance', () => {
  afterEach(() => {
    resetBackgroundSync();
  });

  it('is one instance until it is reset', () => {
    const first = getBackgroundSync();

    // One instance, because `offline-sync.tsx` mounts and unmounts with the auth
    // boundary and each remount must not start a second chain of registrations.
    expect(getBackgroundSync()).toBe(first);

    resetBackgroundSync();
    expect(getBackgroundSync()).not.toBe(first);
  });
});

describe('the browser port', () => {
  /**
   * jsdom has no service worker at all, so the container is put on the instance
   * and taken off again. Deleting rather than restoring a saved descriptor: there
   * is no own descriptor to restore, and leaving a stub behind would make the next
   * test in this file believe a worker exists.
   *
   * Undone from `afterEach` and not at the end of each test, so a failed assertion
   * cannot leave the stub in place and turn one red test into four confusing ones —
   * the same reason `auth-session.test.ts` disposes its live sessions from a hook.
   */
  const restorers: Array<() => void> = [];

  afterEach(() => {
    while (restorers.length > 0) restorers.pop()?.();
  });

  function stubServiceWorker(value: unknown): void {
    Object.defineProperty(navigator, 'serviceWorker', { value, configurable: true });
    restorers.push(() => {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    });
  }

  function registrationWith(active: unknown) {
    return { active } as unknown as ServiceWorkerRegistration;
  }

  it('answers null when the browser has no service worker', async () => {
    // jsdom's own state, asserted rather than assumed: if a future jsdom grows a
    // stub container this test stops meaning anything and should be rewritten.
    expect((navigator as { serviceWorker?: unknown }).serviceWorker).toBeUndefined();
    await expect(browserBackgroundSync().registration()).resolves.toBeNull();
  });

  it('answers the registration whose worker is active', async () => {
    const found = registrationWith({ scriptURL: '/sw.js' });
    stubServiceWorker({ getRegistration: async () => found });

    await expect(browserBackgroundSync().registration()).resolves.toBe(found);
  });

  it('answers null when nothing is registered', async () => {
    stubServiceWorker({ getRegistration: async () => undefined });

    await expect(browserBackgroundSync().registration()).resolves.toBeNull();
  });

  it('answers null for a worker that is still installing', async () => {
    // `sync.register` rejects when the registration has no active worker, and
    // `navigator.serviceWorker.ready` — the alternative — would not settle at all
    // until one did. Skipping costs one arming, which the next queue change asks
    // for again.
    stubServiceWorker({ getRegistration: async () => registrationWith(null) });

    await expect(browserBackgroundSync().registration()).resolves.toBeNull();
  });

  it('answers null when the browser throws instead of answering', async () => {
    stubServiceWorker({
      getRegistration: async () => {
        throw new Error('denied');
      },
    });

    await expect(browserBackgroundSync().registration()).resolves.toBeNull();
  });
});
