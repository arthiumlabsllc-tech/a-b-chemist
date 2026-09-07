import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApiError, createApiClient } from '../api-client';
import {
  OFFLINE_SESSION_MAX_AGE_MS,
  createAuthSession,
  getAuthSession,
  resetAuthSession,
  type AuthSession,
  type TokenStorage,
} from '../auth-session';
import { memoryCache, readSession, rememberSession, type CachePort } from '../offline/cache';

/**
 * The session: who is signed in, which token is where, and when the next refresh
 * happens.
 *
 * Driven through a real `ApiClient` over a fake `fetch` rather than a stubbed
 * client, so the two modules are proved to fit together and not merely to fit
 * their own tests. That matters most for one property: the refresh request has to
 * travel with `withSession: false`, and if it did not, a refusal would make the
 * client answer its own 401 by calling `refresh()` — which the coalescing would
 * hand its own unresolved promise. That failure is a hang, and it is only visible
 * through the real wiring.
 *
 * The offline-restore suite at the bottom is the one to read if you change
 * anything about `endSession`: it is where the rule "a session the server ended
 * cannot be restored from this device" is pinned, and that rule is the only thing
 * standing between an offline restore and a deactivation that stops working
 * whenever the wifi does.
 */

const BASE = 'https://api.abchemist.example';

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Responder = (call: RecordedCall) => Response | Error;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function ok(data: unknown): Response {
  return jsonResponse(200, { success: true, data });
}

function refused(status: number, code: string, message: string): Response {
  return jsonResponse(status, { success: false, error: { message, code } });
}

function networkDown(): Error {
  return new TypeError('Failed to fetch');
}

/**
 * Routes on `METHOD /path`, falling back to the path alone. An unrouted request
 * is a loud failure rather than a hang, because a request the test did not
 * anticipate is the finding.
 */
function recordingFetch(routes: Record<string, Responder>) {
  const calls: RecordedCall[] = [];

  const impl = (async (url: string, init: RequestInit = {}) => {
    const full = String(url);
    const path = full.startsWith(BASE) ? full.slice(BASE.length) : full;
    const method = String(init.method ?? 'GET');
    const raw = init.body;
    calls.push({
      method,
      path,
      body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : null,
      headers: (init.headers ?? {}) as Record<string, string>,
    });

    const call = calls[calls.length - 1];
    if (call === undefined) throw new Error('unreachable');
    const responder = routes[`${method} ${path}`] ?? routes[path];
    if (responder === undefined) throw new Error(`no responder for ${method} ${path}`);

    const result = responder(call);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;

  return {
    impl,
    calls,
    count: (path: string) => calls.filter((call) => call.path === path).length,
    last: (path: string) => calls.filter((call) => call.path === path).pop(),
  };
}

function memoryStorage(initial: string | null = null) {
  const writes: string[] = [];
  let value = initial;
  let clears = 0;

  const storage: TokenStorage & { writes: string[]; clears(): number } = {
    writes,
    clears: () => clears,
    read: () => value,
    write: (token: string) => {
      writes.push(token);
      value = token;
    },
    clear: () => {
      clears += 1;
      value = null;
    },
  };
  return storage;
}

const USER = {
  id: 'u-1',
  fullName: 'Ama Mensah',
  email: 'ama@aandb.example',
  role: 'pharmacist' as const,
  isActive: true,
};

function loginPayload(overrides: Record<string, unknown> = {}) {
  return {
    user: USER,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessExpiresInSeconds: 900,
    permissions: ['sales:create', 'sales:read', 'payments:verify'],
    ...overrides,
  };
}

function refreshPayload(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    accessExpiresInSeconds: 900,
    ...overrides,
  };
}

interface Harness {
  session: AuthSession;
  storage: ReturnType<typeof memoryStorage>;
  sessionCache: CachePort;
  count(path: string): number;
  last(path: string): RecordedCall | undefined;
  calls: RecordedCall[];
}

function harness(routes: Record<string, Responder>, stored: string | null = null): Harness {
  const { impl, calls, count, last } = recordingFetch(routes);
  const storage = memoryStorage(stored);
  // A fresh cache per harness, so an identity one test cached cannot be restored by
  // the next and turn an unrelated failure into a mystery.
  const sessionCache = memoryCache();

  // The same forward reference the app uses: the client needs the session's
  // tokens and the session needs the client.
  let built: AuthSession | null = null;
  const api = createApiClient({
    baseUrl: BASE,
    fetchImpl: impl,
    tokens: {
      getAccessToken: () => built?.tokens.getAccessToken() ?? null,
      refresh: async () => (await built?.tokens.refresh()) ?? false,
      onUnauthenticated: () => built?.tokens.onUnauthenticated(),
    },
  });

  built = createAuthSession({ api, storage, sessionCache });
  const session = built;
  live.push(session);

  return { session, storage, sessionCache, count, last, calls };
}

/** Lets a fire-and-forget cache write or delete land before it is asserted on. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Every session that has signed in is holding a scheduled refresh — a real
 * fourteen-minute timer in the suites that do not use fake ones. Left running,
 * those keep a jest worker from exiting and the run ends with a warning instead
 * of a result.
 */
const live: AuthSession[] = [];

afterEach(() => {
  jest.useRealTimers();
  while (live.length > 0) live.pop()?.dispose();
  // The app-wide singleton is module state, so a test that builds one would
  // otherwise hand it to every test after it.
  resetAuthSession();
});

describe('signing in', () => {
  it('holds the user, the permissions and the access token', async () => {
    const { session } = harness({ 'POST /auth/login': () => ok(loginPayload()) });

    await session.signIn('ama@aandb.example', 'correct horse');

    const state = session.store.getState();
    expect(state.status).toBe('signed-in');
    expect(state.user).toEqual(USER);
    expect(state.permissions).toEqual(['sales:create', 'sales:read', 'payments:verify']);
    expect(state.accessToken).toBe('access-1');
    expect(state.signingIn).toBe(false);
  });

  it('never writes the access token to storage', async () => {
    const { session, storage } = harness({ 'POST /auth/login': () => ok(loginPayload()) });

    await session.signIn('ama@aandb.example', 'correct horse');

    // The invariant the whole token split rests on: what lands on disk is the
    // token the owner can revoke instantly, and never the one that authorises a
    // sale. A tablet walked off with must not carry a working access token.
    expect(storage.writes).toEqual(['refresh-1']);
    expect(storage.writes).not.toContain('access-1');
  });

  it('sends no stale bearer token with a sign-in', async () => {
    const { session, last } = harness({ 'POST /auth/login': () => ok(loginPayload()) });

    await session.signIn('ama@aandb.example', 'correct horse');

    // On a shared counter tablet, a login wearing the last person's token is how
    // one cashier's sale ends up attributed to another.
    expect('authorization' in (last('POST /auth/login')?.headers ?? {})).toBe(false);
  });

  it('rethrows a refused sign-in and stops looking busy', async () => {
    const { session } = harness({
      'POST /auth/login': () => refused(401, 'invalid_credentials', 'That email and password do not match our records'),
    });

    const error = await session.signIn('ama@aandb.example', 'wrong').catch((caught: unknown) => caught);

    // Rethrown rather than swallowed: the form has to tell "wrong password" from
    // "this account has been deactivated", and only the caller can say it.
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('That email and password do not match our records');
    expect(session.store.getState().signingIn).toBe(false);
    expect(session.store.getState().status).toBe('signed-out');
  });

  it('looks busy while the sign-in is in flight', async () => {
    // Held on an object rather than in a local: TypeScript narrows a `let` that
    // is only ever assigned inside a closure to `never`, and cannot be told that
    // the responder runs before the assertion.
    const gate: { release: ((value: Response) => void) | null } = { release: null };
    const { session } = harness({
      'POST /auth/login': () =>
        new Promise<Response>((resolve) => {
          gate.release = resolve;
        }) as unknown as Response,
    });

    const pending = session.signIn('ama@aandb.example', 'correct horse');
    expect(session.store.getState().signingIn).toBe(true);

    gate.release?.(ok(loginPayload()));
    await pending;
    expect(session.store.getState().signingIn).toBe(false);
  });
});

describe('coalescing the refresh', () => {
  it('answers six concurrent refreshes with one request', async () => {
    const { session, count } = harness({
      '/auth/refresh': () => ok(refreshPayload()),
    }, 'refresh-1');

    const results = await Promise.all([
      session.tokens.refresh(),
      session.tokens.refresh(),
      session.tokens.refresh(),
      session.tokens.refresh(),
      session.tokens.refresh(),
      session.tokens.refresh(),
    ]);

    // The reason this exists: `/auth/refresh` shares a ten-per-quarter-hour
    // limiter with `/auth/login`, and successes count. A dashboard loading six
    // widgets with an expired token would otherwise spend six of the ten on one
    // page load and lock the counter out of signing back in.
    expect(count('/auth/refresh')).toBe(1);
    expect(results).toEqual([true, true, true, true, true, true]);
  });

  it('lets a later refresh through once the first has settled', async () => {
    let issued = 0;
    const { session, count } = harness({
      '/auth/refresh': () => {
        issued += 1;
        return ok(refreshPayload({ accessToken: `access-${issued}`, refreshToken: `refresh-${issued}` }));
      },
    }, 'refresh-0');

    expect(await session.tokens.refresh()).toBe(true);
    expect(await session.tokens.refresh()).toBe(true);

    // Coalescing is about concurrent calls, not about caching: a second refresh
    // after the first has landed must still be able to rotate the token.
    expect(count('/auth/refresh')).toBe(2);
    expect(session.store.getState().accessToken).toBe('access-2');
  });

  it('gives every coalesced caller the same failure', async () => {
    const { session, count } = harness({
      '/auth/refresh': () => refused(401, 'invalid_token', 'This session has ended. Sign in again.'),
    }, 'refresh-1');

    const results = await Promise.all([session.tokens.refresh(), session.tokens.refresh()]);

    expect(count('/auth/refresh')).toBe(1);
    expect(results).toEqual([false, false]);
  });

  it('does not hang when the refresh itself is refused', async () => {
    const { session, count } = harness({
      '/auth/refresh': () => refused(401, 'invalid_token', 'This session has ended. Sign in again.'),
    }, 'refresh-1');

    // Sent down the authenticated path, this deadlocks: the client answers its own
    // 401 by calling `refresh()`, and the coalescing hands it its own unresolved
    // promise. The failure mode is a hang, not an error, so the test reaching this
    // line at all is the assertion.
    await expect(session.tokens.refresh()).resolves.toBe(false);
    expect(count('/auth/refresh')).toBe(1);
  });
});

describe('rotating the tokens', () => {
  it('persists the new refresh token and holds the new access token', async () => {
    const { session, storage } = harness({
      '/auth/refresh': () => ok(refreshPayload()),
    }, 'refresh-1');

    expect(await session.tokens.refresh()).toBe(true);

    // Rotation replaces both. Keeping the old refresh token would leave the next
    // renewal presenting a token the server has already superseded.
    expect(storage.read()).toBe('refresh-2');
    expect(session.store.getState().accessToken).toBe('access-2');
  });
});

describe('the scheduled refresh', () => {
  it('refreshes ahead of expiry without being asked', async () => {
    jest.useFakeTimers();
    let refreshes = 0;
    const { session } = harness({
      'POST /auth/login': () => ok(loginPayload()),
      '/auth/refresh': () => {
        refreshes += 1;
        return ok(refreshPayload({ accessToken: `access-${refreshes + 1}`, refreshToken: `refresh-${refreshes + 1}` }));
      },
    });

    await session.signIn('ama@aandb.example', 'correct horse');

    // A 900s token with a 60s lead is refreshed at 840s.
    await jest.advanceTimersByTimeAsync(839_999);
    expect(refreshes).toBe(0);

    await jest.advanceTimersByTimeAsync(1);
    expect(refreshes).toBe(1);

    // Read from `accessExpiresInSeconds` rather than a hard-coded hour, so
    // changing JWT_ACCESS_TTL_SECONDS on the server cannot desynchronise the two.
    expect(session.store.getState().accessToken).toBe('access-2');
    session.dispose();
  });

  it('does not spin when the API sends a nonsense token lifetime', async () => {
    jest.useFakeTimers();
    let refreshes = 0;
    const { session } = harness({
      'POST /auth/login': () => ok(loginPayload({ accessExpiresInSeconds: 0 })),
      '/auth/refresh': () => {
        refreshes += 1;
        return ok(refreshPayload({ accessExpiresInSeconds: 0 }));
      },
    });

    await session.signIn('ama@aandb.example', 'correct horse');
    await jest.advanceTimersByTimeAsync(60_000);

    // A zero lifetime puts the deadline in the past, so a naive schedule fires at
    // once, receives another zero, and fires again — burning the whole
    // ten-per-quarter-hour allowance in under a second and locking the counter out.
    expect(refreshes).toBe(0);
    session.dispose();
  });

  it('stops the schedule when the session is disposed', async () => {
    jest.useFakeTimers();
    const { session } = harness({
      'POST /auth/login': () => ok(loginPayload()),
      '/auth/refresh': () => ok(refreshPayload()),
    });

    await session.signIn('ama@aandb.example', 'correct horse');
    session.dispose();

    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('restoring a session at boot', () => {
  it('does nothing at all when no refresh token was persisted', async () => {
    const { session, calls } = harness({ '/auth/refresh': () => ok(refreshPayload()) });

    await expect(session.restore()).resolves.toBe(false);

    expect(calls).toHaveLength(0);
    expect(session.store.getState().status).toBe('signed-out');
    expect(session.store.getState().signedOutReason).toBe('never');
  });

  it('renews and then asks who is signed in', async () => {
    const { session, count } = harness({
      '/auth/refresh': () => ok(refreshPayload()),
      '/auth/me': () => ok({ user: USER, permissions: ['sales:create', 'reports:read'] }),
    }, 'refresh-1');

    await expect(session.restore()).resolves.toBe(true);

    const state = session.store.getState();
    expect(state.status).toBe('signed-in');
    expect(state.user).toEqual(USER);
    expect(state.permissions).toEqual(['sales:create', 'reports:read']);
    expect(state.accessToken).toBe('access-2');
    // Two requests, because `/auth/refresh` returns tokens but not the person.
    expect(count('/auth/refresh')).toBe(1);
    expect(count('/auth/me')).toBe(1);
  });

  it('clears the token when the server says the session is over', async () => {
    const { session, storage } = harness({
      '/auth/refresh': () => refused(401, 'session_revoked', 'This session has ended. Sign in again.'),
    }, 'refresh-1');

    await expect(session.restore()).resolves.toBe(false);

    expect(storage.read()).toBeNull();
    expect(session.store.getState().signedOutReason).toBe('session-ended');
  });

  it('names a deactivated account distinctly from an ended session', async () => {
    const { session, storage } = harness({
      '/auth/refresh': () => refused(403, 'account_disabled', 'This account has been deactivated. Speak to the owner.'),
    }, 'refresh-1');

    await expect(session.restore()).resolves.toBe(false);

    // A 403 is only a dead session when it carries one of the two codes that mean
    // the account itself cannot be used. The remedy here is "find the owner", not
    // "type your password again", and the sign-in page has to say which.
    expect(storage.read()).toBeNull();
    expect(session.store.getState().signedOutReason).toBe('account-disabled');
  });

  it('keeps the token when the server simply cannot be reached', async () => {
    const { session, storage } = harness({
      '/auth/refresh': () => networkDown(),
    }, 'refresh-1');

    await expect(session.restore()).resolves.toBe(false);

    // The offline case. Wiping the refresh token because a mast was down would
    // sign the pharmacy out and strand whatever the queue was holding, and the
    // cashier would have to sign in again to recover it.
    expect(storage.read()).toBe('refresh-1');
    expect(session.store.getState().signedOutReason).toBe('unreachable');
    expect(session.store.getState().status).toBe('signed-out');
  });

  it('keeps the token when a 500 answers the renewal', async () => {
    const { session, storage } = harness({
      '/auth/refresh': () => jsonResponse(500, { success: false, error: { message: 'Something went wrong' } }),
    }, 'refresh-1');

    await expect(session.restore()).resolves.toBe(false);

    // A fault on our side is not an answer about the session.
    expect(storage.read()).toBe('refresh-1');
  });

  it('gives up when the renewed token is refused by /auth/me', async () => {
    const { session, storage } = harness({
      '/auth/refresh': () => ok(refreshPayload()),
      '/auth/me': () => refused(401, 'token_invalid', 'Session expired or invalid. Sign in again.'),
    }, 'refresh-1');

    await expect(session.restore()).resolves.toBe(false);

    expect(storage.read()).toBeNull();
    expect(session.store.getState().signedOutReason).toBe('session-ended');
  });
});

/**
 * A tablet that restarts during an outage cannot reach `/auth/refresh`, and before
 * Phase 9 that meant the login page: signed out, holding a queue of unsent sales it
 * could not send, in front of a till it could not open. These tests cover the
 * fallback that replaced it, and — more importantly — the four ways it must refuse.
 */
describe('the offline restore', () => {
  it('restores the cached identity when the server cannot be reached', async () => {
    const { session, storage, sessionCache } = harness(
      { '/auth/refresh': () => networkDown() },
      'refresh-1'
    );
    await rememberSession(sessionCache, USER, ['sales:create', 'payments:add']);

    // True, and not merely "did not throw": a restored session is a persisted
    // session, and the boot code branches on this to decide whether to send anybody
    // to the login page.
    await expect(session.restore()).resolves.toBe(true);

    const state = session.store.getState();
    expect(state.status).toBe('signed-in');
    expect(state.user).toEqual(USER);
    expect(state.permissions).toEqual(['sales:create', 'payments:add']);
    // The one field that keeps this from being a lie. Nothing has confirmed who this
    // is, and the UI has to say so rather than showing the cached name as fact.
    expect(state.offline).toBe(true);
    // There is no access token and the store must not pretend otherwise: an offline
    // restore grants the ability to use the till and to queue, not to call anything.
    expect(state.accessToken).toBeNull();
    expect(storage.read()).toBe('refresh-1');
  });

  it('refuses to restore when there is no refresh token to restore against', async () => {
    const { session, sessionCache, count } = harness({}, null);
    await rememberSession(sessionCache, USER, ['sales:create']);

    await expect(session.restore()).resolves.toBe(false);

    expect(session.store.getState().status).toBe('signed-out');
    expect(session.store.getState().signedOutReason).toBe('never');
    expect(session.store.getState().offline).toBe(false);
    // Defence in depth, and the reason a cache write that silently failed to be
    // deleted is not a hole: with no token there is nothing for a cached identity to
    // attach to, so the two only ever restore together.
    expect(count('/auth/refresh')).toBe(0);
  });

  it('drops the cached identity when the server says the session is over', async () => {
    const { session, storage, sessionCache } = harness(
      {
        '/auth/refresh': () =>
          refused(401, 'session_revoked', 'This session has ended. Sign in again.'),
      },
      'refresh-1'
    );
    await rememberSession(sessionCache, USER, ['sales:create']);

    await expect(session.restore()).resolves.toBe(false);

    expect(session.store.getState().signedOutReason).toBe('session-ended');
    await settle();
    // The load-bearing assertion in this suite. Without it a revoked session would
    // stay restorable from this device, and the next outage would hand the till back
    // to somebody the server had already signed out.
    expect(await readSession(sessionCache)).toBeNull();
    expect(storage.read()).toBeNull();
  });

  it('drops the cached identity when the account is deactivated', async () => {
    const { session, sessionCache } = harness(
      {
        '/auth/refresh': () =>
          refused(403, 'account_disabled', 'This account has been deactivated. Speak to the owner.'),
      },
      'refresh-1'
    );
    await rememberSession(sessionCache, USER, ['sales:create']);

    await expect(session.restore()).resolves.toBe(false);

    expect(session.store.getState().signedOutReason).toBe('account-disabled');
    await settle();
    // Otherwise deactivating a staff member would take effect only while their
    // tablet could reach the server — which is precisely when it does not matter.
    expect(await readSession(sessionCache)).toBeNull();
  });

  it('refuses a cached identity older than the refresh token it sits beside', async () => {
    const { session, storage, sessionCache } = harness(
      { '/auth/refresh': () => networkDown() },
      'refresh-1'
    );
    const cachedAt = Date.now();
    await rememberSession(sessionCache, USER, ['sales:create']);

    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValue(cachedAt + OFFLINE_SESSION_MAX_AGE_MS + 1);
    try {
      await expect(session.restore()).resolves.toBe(false);
    } finally {
      now.mockRestore();
    }

    expect(session.store.getState().status).toBe('signed-out');
    expect(session.store.getState().signedOutReason).toBe('unreachable');
    await settle();
    // Dropped rather than left to be re-judged on every boot, and the token is kept:
    // an outage is still an outage, so the sign-in page offers to try again instead
    // of asking for a password this tablet cannot check.
    expect(await readSession(sessionCache)).toBeNull();
    expect(storage.read()).toBe('refresh-1');
  });

  it('keeps the token it was just given when /auth/me is the request that fails', async () => {
    const { session, sessionCache } = harness(
      { '/auth/refresh': () => ok(refreshPayload()), '/auth/me': () => networkDown() },
      'refresh-1'
    );
    await rememberSession(sessionCache, USER, ['sales:create']);

    await expect(session.restore()).resolves.toBe(true);

    // The connection dropped between the two boot requests. The refresh had already
    // succeeded, so the token is the one thing the server confirmed and clearing it
    // would throw that away.
    expect(session.store.getState().accessToken).toBe('access-2');
    // Still unconfirmed: the token was checked, the *identity* was not — it came from
    // the cache. Those are different facts and the flag is about the second.
    expect(session.store.getState().offline).toBe(true);
    expect(session.store.getState().user).toEqual(USER);
  });

  it('stops being unconfirmed the moment the server accepts a refresh', async () => {
    // A responder that changes behaviour, because the thing under test is a
    // transition: the tablet comes back within one page session, with no reload.
    let reachable = false;
    const { session, sessionCache } = harness(
      { '/auth/refresh': () => (reachable ? ok(refreshPayload()) : networkDown()) },
      'refresh-1'
    );
    await rememberSession(sessionCache, USER, ['sales:create']);

    await session.restore();
    expect(session.store.getState().offline).toBe(true);

    reachable = true;
    await expect(session.tokens.refresh()).resolves.toBe(true);

    // A refresh token the server accepts is one a revoked, deactivated or expired
    // session cannot get, so this is the confirmation the restore was missing. The
    // queued sales go through the same door, which is what makes the whole scheme
    // safe rather than merely convenient.
    expect(session.store.getState().offline).toBe(false);
    expect(session.store.getState().status).toBe('signed-in');
    expect(session.store.getState().accessToken).toBe('access-2');
  });
});

describe('what signing in leaves on the device', () => {
  it('caches the identity, so a restart during an outage has something to restore', async () => {
    const { session, sessionCache } = harness({ 'POST /auth/login': () => ok(loginPayload()) });

    await session.signIn('ama@aandb.example', 'correct horse');

    const cached = await readSession(sessionCache);
    expect(cached?.value.user).toEqual(USER);
    expect(cached?.value.permissions).toEqual(['sales:create', 'sales:read', 'payments:verify']);
    // Awaited inside `signIn` rather than fire-and-forget, so the write has landed
    // before the till is usable — a cache written after the first navigation may
    // never be written at all on a tablet closed at the end of the shift.
    expect(cached?.fetchedAt).toBeLessThanOrEqual(Date.now());
    expect(session.store.getState().offline).toBe(false);
  });

  it('drops the cached identity on sign-out, so the next person cannot inherit it', async () => {
    const { session, sessionCache } = harness({
      'POST /auth/login': () => ok(loginPayload()),
      'POST /auth/logout': () => ok({}),
    });
    await session.signIn('ama@aandb.example', 'correct horse');
    expect(await readSession(sessionCache)).not.toBeNull();

    await session.signOut();
    await settle();

    // A shared counter tablet signed out at closing time must open on the login page,
    // not on the last cashier's till.
    expect(await readSession(sessionCache)).toBeNull();
    expect(session.store.getState().offline).toBe(false);
  });

  it('drops the cached identity when signing out offline', async () => {
    const { session, sessionCache } = harness({
      'POST /auth/login': () => ok(loginPayload()),
      'POST /auth/logout': () => networkDown(),
    });
    await session.signIn('ama@aandb.example', 'correct horse');

    // `signOut` swallows the network failure on purpose — a tablet out of range at
    // closing time must still be signable out — and the cache has to go regardless.
    await session.signOut();
    await settle();

    expect(await readSession(sessionCache)).toBeNull();
    expect(session.store.getState().signedOutReason).toBe('signed-out');
  });
});

describe('the offline bound mirrors the backend', () => {
  it('is the refresh-token lifetime, read from the backend rather than restated', () => {
    // Four levels up from `frontend/src/lib/__tests__` is the monorepo root, the same
    // derivation `api-types.mirror.test.ts` uses.
    const configPath = join(__dirname, '..', '..', '..', '..', 'backend', 'src', 'config', 'index.ts');
    const source = readFileSync(configPath, 'utf8');
    const match = /JWT_REFRESH_TTL_DAYS',\s*(\d+)/.exec(source);

    expect(match).not.toBeNull();
    // The two are a pair. A longer bound here than there would leave the till
    // honouring a cached identity after the server had stopped honouring the refresh
    // token sitting beside it in localStorage — and nothing else in the frontend
    // would notice, because the frontend never sees the token's expiry.
    expect(OFFLINE_SESSION_MAX_AGE_MS).toBe(Number(match?.[1]) * 24 * 60 * 60 * 1000);
  });
});

describe('signing out', () => {
  it('tells the server and then clears everything locally', async () => {
    const { session, storage, count } = harness({
      'POST /auth/login': () => ok(loginPayload()),
      'POST /auth/logout': () => ok({ signedOut: true }),
    });

    await session.signIn('ama@aandb.example', 'correct horse');
    await session.signOut();

    expect(count('/auth/logout')).toBe(1);
    expect(storage.read()).toBeNull();
    const state = session.store.getState();
    expect(state.status).toBe('signed-out');
    expect(state.user).toBeNull();
    expect(state.accessToken).toBeNull();
    expect(state.permissions).toEqual([]);
    expect(state.signedOutReason).toBe('signed-out');
  });

  it('clears locally even when the server cannot be reached', async () => {
    const { session, storage } = harness({
      'POST /auth/login': () => ok(loginPayload()),
      'POST /auth/logout': () => networkDown(),
    });

    await session.signIn('ama@aandb.example', 'correct horse');
    await session.signOut();

    // Staying signed in because the network was down is the worse failure: the
    // next person at the counter would inherit the last person's session.
    expect(storage.read()).toBeNull();
    expect(session.store.getState().status).toBe('signed-out');
  });
});

describe('when the API says the credentials stopped working', () => {
  it('drops the access token but keeps the session it could not confirm as dead', async () => {
    const { session, storage } = harness({
      'POST /auth/login': () => ok(loginPayload()),
    });

    await session.signIn('ama@aandb.example', 'correct horse');
    session.tokens.onUnauthenticated();

    // The server refused the credentials but never confirmed the session is over
    // — the renewal could not be reached, for instance. Forget the access token so
    // the next request asks for a new one, and keep the persisted session.
    expect(session.store.getState().accessToken).toBeNull();
    expect(session.store.getState().status).toBe('signed-in');
    expect(storage.read()).toBe('refresh-1');
  });

  it('does nothing extra once the server has already ended the session', async () => {
    const { session, storage } = harness({
      '/auth/refresh': () => refused(401, 'session_revoked', 'This session has ended. Sign in again.'),
    }, 'refresh-1');

    await session.tokens.refresh();
    const clearsBefore = storage.clears();
    session.tokens.onUnauthenticated();

    expect(storage.clears()).toBe(clearsBefore);
    expect(session.store.getState().signedOutReason).toBe('session-ended');
  });
});

describe('asking what this person may do', () => {
  it('answers from the permissions the server granted', async () => {
    const { session } = harness({
      'POST /auth/login': () => ok(loginPayload({ permissions: ['sales:create', 'sales:read'] })),
    });

    await session.signIn('ama@aandb.example', 'correct horse');

    expect(session.can('sales:create')).toBe(true);
    // Counter staff cannot void a sale, and the till has to know that before it
    // offers the button rather than after the server refuses it.
    expect(session.can('sales:void')).toBe(false);
  });

  it('grants nothing while signed out', () => {
    const { session } = harness({});

    expect(session.can('sales:create')).toBe(false);
  });
});

describe('the state a router guard sees first', () => {
  it('reports a persisted token as still being checked', () => {
    const { session } = harness({ '/auth/refresh': () => ok(refreshPayload()) }, 'refresh-1');

    // Decided synchronously at construction, not in `restore()` and not in an
    // effect. Anything later opens a window in which a cashier who is signed in
    // reads as signed out, and a guard that looks inside that window sends them
    // to the login page — on every reload, which on a till left open all day is
    // every morning.
    expect(session.store.getState().status).toBe('restoring');
    expect(session.store.getState().signedOutReason).toBe('never');
  });

  it('reports no persisted token as signed out', () => {
    const { session } = harness({});

    // The other half: a tablet with nothing stored must not sit in 'restoring'
    // and hold the guard on a splash screen waiting for a check that will never
    // be made.
    expect(session.store.getState().status).toBe('signed-out');
  });
});

describe('the app-wide session', () => {
  /**
   * jsdom implements no `fetch`, and `createApiClient` reads the global when it
   * is built. Every browser that can run this till has one, so this is the test
   * environment missing a browser API rather than the client being wrong to need
   * it — and nothing below makes a request. Deliberately not "fixed" by making
   * the client resolve `fetch` lazily: shaping production code around a gap in
   * jsdom is the wrong way round.
   */
  const fetchStub = (() => Promise.reject(new Error('no request expected'))) as unknown as typeof fetch;

  beforeEach(() => {
    globalThis.fetch = fetchStub;
  });

  /** Runs `body` with `window` removed, which is all the server has to look like. */
  function withoutWindow(body: () => void): void {
    const saved = globalThis.window;
    // @ts-expect-error removing `window` is exactly what makes this the server
    delete globalThis.window;
    try {
      body();
    } finally {
      globalThis.window = saved;
    }
  }

  it('hands back the same session every time', () => {
    // One session, one scheduled refresh. A second instance would read the same
    // storage and run its own timer, so the pair would each spend a slot of the
    // ten-per-quarter-hour allowance the counter needs for signing in.
    expect(getAuthSession()).toBe(getAuthSession());
  });

  it('refuses to be built while rendering on the server', () => {
    withoutWindow(() => {
      // Module scope on the server belongs to the process, not to the request. A
      // session built while rendering would still be sitting there for the next
      // visitor, holding the previous visitor's refresh token, and every test
      // that runs in a browser environment would stay green through it.
      expect(() => getAuthSession()).toThrow(/server rendering/);
    });
  });

  it('is still usable in the browser after being refused on the server', () => {
    withoutWindow(() => {
      expect(() => getAuthSession()).toThrow(/server rendering/);
    });

    // A refused call must not poison the module: the guard throws before the
    // singleton is assigned, so the real client-side call still works.
    expect(getAuthSession().store.getState().status).toBe('signed-out');
  });
});
