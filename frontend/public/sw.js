/*
 * A&B Chemist service worker.
 *
 * Hand-written on purpose: the caching rules ARE the product. Which requests may
 * be served from cache, which must always reach the network, and what happens to
 * a response that came back wrong are decisions a generated worker makes by
 * default — and the previous build's default cached a failed navigation and then
 * served that failure back to the till while offline, which looked exactly like
 * the app being broken when it was in fact faithfully replaying a cached error.
 *
 * Phase 1 established the rules. Phase 9 adds the offline read cache for
 * navigations and the background-sync handoff on top of them, and changes none:
 * `CACHEABLE` and `cacheFirst` below are as they were, and the two refusals about
 * non-ok and redirected responses now govern the navigation cache too.
 *
 * ## What this worker never does
 *
 * It never replays a queued sale. The queue lives in the page's IndexedDB and the
 * tokens that authorise a write live in the page's memory, so the worker could not
 * post one even if it should — and a worker that could would be a second writer
 * with its own idea of what had been sent, which is the duplicate-sale failure the
 * `clientSaleId` exists to prevent, reintroduced at a layer nobody watches. All it
 * does is tell the page the moment has come. `components/offline-sync.tsx` holds
 * the other half of that handshake.
 *
 * It never touches the API. A different origin, carrying patient records and
 * payment data. Nothing from it enters this cache in any phase.
 */

/**
 * Not bumped for Phase 9, and the reason is the outage this worker exists for.
 *
 * `activate` deletes every cache under a different name, so a rename empties the
 * device at the moment the new worker takes over — and if the tablet then loses
 * the connection before it has re-fetched, the till boots to nothing on the
 * strength of a deploy. Navigation entries are new keys in the same store and
 * collide with nothing already there, so an existing install simply starts
 * accumulating them. Bump this only when a stored entry has to be *thrown away*,
 * and then only accepting that cost deliberately.
 */
const CACHE = 'ab-chemist-v1';

/**
 * One literal, used as the background-sync tag and as the message type posted back
 * to the page. `lib/offline/background-sync.ts` holds the same string as
 * `BACKGROUND_SYNC_TAG` and cannot import it from here, so the two are kept in step
 * by `background-sync.mirror.test.ts`, which reads this file and fails when they
 * disagree. A second constant on this side would be a second way to drift.
 */
const SYNC_TAG = 'ab-chemist-sync';

// Content-hashed build output and the generated icons: the URL changes whenever
// the bytes do, so a cache hit here can never be stale. Everything else —
// pages, auth, the API — is governed by its own rule below or never cached at all.
const CACHEABLE = /^\/(_next\/static\/|icons\/)/;

self.addEventListener('install', (event) => {
  // Take over immediately. A till left on yesterday's bundle keeps yesterday's
  // prices and yesterday's bugs, and "wait until every tab closes" means waiting
  // for a pharmacy to shut — which it does not do during trading hours.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
      );
      // Claim the open tabs too, so the new worker governs the page that
      // installed it instead of only the next one to load.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // The write path. POST and PUT are sales, stock movements and patient
  // records. The worker never caches or replays one on its own authority.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // The API is a different origin, and it carries patient and payment data.
  // None of it enters this cache, in any phase.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationRequest(request));
    return;
  }

  if (!CACHEABLE.test(url.pathname)) return;

  event.respondWith(cacheFirst(request));
});

/**
 * Network first, with the last good copy of *this URL* as the offline answer.
 *
 * Network first because a navigation is a page and a page is not content-hashed:
 * serving a stored one while the server is reachable would put a till built from
 * last week's bundle in front of the operator, and they would have no way to tell.
 * Here the cache is the fallback and never the source.
 *
 * ## Per-URL, and never one shared "shell"
 *
 * The tempting design is to store `/pos` once and answer every navigation with it,
 * so any route boots offline. It does not work: the stored bytes carry the RSC
 * payload and the script tags of the URL they came from, so answering `/reports`
 * with them renders a page that claims to be somewhere it is not, and the mismatch
 * surfaces as a hydration error the operator cannot distinguish from the app being
 * broken. Serving only what was fetched for the URL asked for means a route the
 * device has visited works offline and one it has not says so plainly — which is
 * the honest half of the same rule.
 *
 * ## Why `mode === 'navigate'` and not a path test
 *
 * The App Router fetches its RSC payloads as ordinary GETs with a `_rsc` query
 * parameter and `mode: 'cors'`. A path-based rule would cache those too, filing a
 * partial tree under a URL that never produced a document and then serving it back
 * as one.
 */
async function navigationRequest(request) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    // Could not reach the server at all — the only thing that makes an offline
    // answer legitimate. A 404 or a 500 is a response and is returned below as one.
    const cache = await caches.open(CACHE);
    const stored = await cache.match(request);
    return stored ?? offlinePage();
  }

  // The two refusals Phase 1 established, unchanged and for the same reasons:
  // - caching a non-ok response stores a failure and serves it back as content,
  //   offline, indefinitely;
  // - caching a redirected response files the redirect target under the URL
  //   that asked for it, a key that never produced those bytes.
  if (response.ok && !response.redirected) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

/**
 * The answer when nothing is stored for the URL asked for.
 *
 * Generated rather than fetched, so it cannot itself be missing — a fallback that
 * has to be downloaded is not a fallback. It exists to say the one thing the
 * browser's own error page cannot: that this is a connection and not a broken app,
 * and that whatever the till was holding is still on the device.
 *
 * No script in it. An inline handler would be the first thing a Content-Security-
 * Policy breaks, and a plain link cannot be.
 */
function offlinePage() {
  const body = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Cannot reach the server &middot; A&amp;B Chemist</title>',
    '</head>',
    '<body style="margin:0;background:#f5f5f4;color:#1c1917;',
    "font-family:ui-sans-serif,system-ui,sans-serif;\">",
    '<main style="max-width:34rem;margin:0 auto;padding:3rem 1.5rem;">',
    '<h1 style="font-size:1.25rem;margin:0 0 0.75rem;">Cannot reach the server</h1>',
    '<p style="line-height:1.6;margin:0 0 0.75rem;">',
    'This page is not stored on this device, so it cannot be opened without a',
    ' connection. The app is not broken and nothing has been lost: any sale the',
    ' till was holding is still on this device and is sent when the connection',
    ' returns.',
    '</p>',
    '<p style="line-height:1.6;margin:0 0 1.5rem;">',
    'Pages this device has already opened &mdash; the till among them &mdash; work',
    ' offline. Try the address you were on, or reload once the connection is back.',
    '</p>',
    '<a href="." style="display:inline-block;background:#008753;color:#fff;',
    'text-decoration:none;padding:0.75rem 1.25rem;border-radius:0.5rem;',
    'font-weight:600;">Try again</a>',
    '</main>',
    '</body>',
    '</html>',
  ].join('');

  // 503 rather than 200: a stored page rendered as though it were fresh would be
  // indistinguishable from the real thing, and the whole rule this worker runs on
  // is that a failure is never served as content.
  return new Response(body, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);

  // The same two refusals, and a miss while offline therefore rejects and the
  // browser shows its own error. For a hashed asset that is correct: the page
  // asking for it is either stored and self-consistent, or was not worth serving.
  if (response.ok && !response.redirected) {
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * The handoff. `lib/offline/background-sync.ts` registers this tag whenever the
 * queue holds a sale; the browser fires the event once the connection can carry
 * it, and all the worker does is say so.
 *
 * ## Why not just the page's own `online` listener
 *
 * Because a backgrounded tab does not get one promptly. Chrome throttles timers and
 * defers events in a tab nobody is looking at, which is exactly where a till sits
 * between customers — and a queue that waits for the operator to touch the screen
 * is a queue that is still holding sales at the end of the day. Background sync is
 * not throttled, so this is the path that reconciles a tablet left on a counter.
 *
 * ## Where it is not available
 *
 * Safari and Firefox have never shipped `sync`, so `registration.sync` is undefined
 * there and the page skips the call. Nothing is lost: `offline-sync.tsx` also
 * flushes at boot and on `online`, and this is the extra path rather than the only
 * one.
 */
self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clients) {
        client.postMessage({ type: SYNC_TAG });
      }
      // No client open is not a failure and must not be reported as one. The queue
      // is in IndexedDB, the next tab to open flushes it at boot, and a sync that
      // rejects repeatedly gets its registration blocked — which would remove this
      // path for good over a tablet that happened to be closed.
    })(),
  );
});
