import { createStore, type StoreApi } from 'zustand/vanilla';
import { ApiError, createApiClient, type ApiClient, type TokenSource } from './api-client';
import { frontendConfig } from './frontend-config';
import {
  forgetSession,
  getOfflineCache,
  readSession,
  rememberSession,
  type CacheEntry,
  type CachePort,
  type CachedSession,
} from './offline/cache';

/**
 * Who is signed in, and the tokens that prove it.
 *
 * ## Where each token lives, and why they differ
 *
 * The access token is held in memory only. The refresh token is persisted, in
 * `localStorage`. That split is the whole security posture of the till and it is
 * worth stating plainly:
 *
 * - The access token is what authorises a sale, and it never touches disk. A
 *   tablet walked off with, or a browser profile copied, takes a refresh token
 *   that the owner can kill from anywhere by deactivating the account or
 *   changing the password — both of which bump `session_version`, and every
 *   access token minted before that stops verifying on the next request.
 * - The refresh token is persisted because the alternative is signing out on
 *   every page reload, which on a till that is left open all day is a nuisance
 *   and, during a power cut, a loss of whatever the offline queue was holding.
 * - `localStorage` rather than `sessionStorage` for the same reason. Phase 9's
 *   queue has to survive a browser restart: a tablet that comes back from a
 *   power cut holding unsynced sales must still be able to authenticate them.
 *
 * ## Why the refresh is coalesced
 *
 * `/auth/refresh` sits behind the same ten-per-quarter-hour limiter as
 * `/auth/login`, and successful attempts count. A dashboard that loads six
 * widgets with an expired token would otherwise spend six of those ten on one
 * page load and lock the counter out of signing back in — which looks like a
 * broken password, not a rate limit, to whoever is standing there.
 *
 * ## The offline restore, and what it is not
 *
 * A tablet that restarts during an outage cannot reach `/auth/refresh`, so it used
 * to land on the login page: signed out, holding a queue of unsent sales it could
 * not send, in front of a till it could not open. `restore()` now falls back to the
 * cached identity in that one case and marks the session `offline` while it does.
 *
 * Three things keep that from being a hole:
 *
 * - It is gated on the refresh token still being in `localStorage`, and
 *   `endSession` clears the token and the cached identity together. A session the
 *   server ended — revoked, deactivated, signed out — therefore cannot be restored
 *   offline. Nor can a cache write that silently failed resurrect one: with no
 *   token there is nothing to restore against.
 * - It is bounded in time by `OFFLINE_SESSION_MAX_AGE_MS`, which mirrors the
 *   backend's refresh-token lifetime, so a tablet that is never reconnected does
 *   not stay unlocked forever.
 * - It grants no authority. BRIEF.md §4.1 is that permissions are enforced
 *   server-side on every route and that hiding a button is not authorisation, so a
 *   cached permission list only decides what the UI offers. Every sale queued
 *   offline is checked by the server when it is replayed, and a deactivated account
 *   cannot get a refresh token to replay it with.
 *
 * What it cannot do is tell who is standing at the counter. A shared tablet
 * restarted during an outage opens as whoever signed in last, and the only defence
 * is that the session says so out loud — see `offline-indicator.tsx`.
 */

/**
 * Mirrors `USER_ROLES` in backend/src/utils/permissions.ts, which is the source
 * of truth. The backend's own test pins its list; if a role is added there and
 * not here, the role string still arrives and is displayed — only a UI branch
 * keyed on the literal would need updating.
 */
export const USER_ROLES = ['pharmacy_owner', 'pharmacist', 'staff'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * The permission names this app asks about, mirroring `PERMISSIONS` in
 * backend/src/utils/permissions.ts.
 *
 * A union rather than `string` so that `can('sales:voi')` is a compile error
 * instead of a button that silently never appears. The granted list itself
 * arrives as strings and is checked by membership, so a permission the server
 * adds and the UI has not used yet needs no change here.
 */
export type Permission =
  | 'sales:create'
  | 'sales:read'
  | 'sales:void'
  | 'payments:add'
  | 'payments:verify'
  | 'inventory:read'
  | 'inventory:receive'
  | 'inventory:adjust'
  | 'inventory:write_off'
  | 'inventory:product:write'
  | 'inventory:import'
  | 'inventory:recall:read'
  | 'inventory:alerts:scan'
  | 'reports:read'
  | 'staff:manage'
  | 'tax:read'
  | 'tax:change'
  | 'patients:read'
  | 'patients:write'
  | 'screenings:write'
  | 'consultations:write'
  | 'prescriptions:approve'
  | 'notifications:read'
  | 'notifications:refresh';

/**
 * The user as the API returns it. `passwordHash` is not in this type at all.
 *
 * The tag is read by `lib/__tests__/api-types.mirror.test.ts`, which parses the
 * backend interface and fails if a member is added, removed or retyped on either
 * side. `USER_ROLES` and `Permission` above are hand-copies too and are guarded
 * by the same suite, as values rather than as an interface.
 *
 * @mirrors backend/src/services/auth.service.ts SafeUser
 */
export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  isActive: boolean;
}

export type SessionStatus = 'signed-out' | 'restoring' | 'signed-in';

/**
 * Why there is nobody signed in, which the sign-in page has to say because the
 * remedies are different: a revoked session needs signing in again, a
 * deactivated account needs the owner, and an unreachable server needs waiting.
 */
export type SignedOutReason =
  | 'never'
  | 'signed-out'
  | 'session-ended'
  | 'account-disabled'
  | 'unreachable';

export interface AuthSessionState {
  status: SessionStatus;
  user: AuthUser | null;
  /** Strings rather than `Permission[]`: the server decides this list. */
  permissions: readonly string[];
  /** In memory only, never persisted. See the module docstring. */
  accessToken: string | null;
  /** Epoch milliseconds, derived from `accessExpiresInSeconds`. */
  accessExpiresAt: number | null;
  signedOutReason: SignedOutReason;
  /** True while a sign-in is in flight, so the form can disable its button. */
  signingIn: boolean;
  /**
   * True when this session was restored from the device cache because the server
   * could not be reached, and has not confirmed it since.
   *
   * Not a connection flag — `navigator.onLine` and `offline-indicator.tsx` own
   * that. This is about authority: the name on screen and the permissions gating
   * the nav are the ones the server last gave this device and nobody has checked
   * them since. The UI says so while it is true, and a successful refresh clears
   * it, because a refresh token the server accepts is one a revoked, deactivated
   * or expired session cannot get.
   */
  offline: boolean;
}

export interface AuthSession {
  store: StoreApi<AuthSessionState>;
  /** Handed to `createApiClient`. */
  tokens: TokenSource;
  /** The client this session talks through, so a page does not build its own. */
  api: ApiClient;
  /** Throws an `ApiError` the sign-in form can read; does not swallow it. */
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Restores a persisted session at boot. Resolves false if there was none. */
  restore(): Promise<boolean>;
  can(permission: Permission): boolean;
  /** Stops the scheduled refresh. Called on teardown and between tests. */
  dispose(): void;
}

/** Where the refresh token is kept. Injectable so a test never touches a browser. */
export interface TokenStorage {
  read(): string | null;
  write(token: string): void;
  clear(): void;
}

/**
 * `localStorage`, wrapped because it throws.
 *
 * It throws when storage is full, when the browser is configured to block it and
 * in some private-browsing modes. A till that crashed on sign-in because the
 * tablet's storage was full would be an absurd thing to debug at a counter, so
 * every access is guarded and the failure degrades to "this tab only": the
 * session works, and simply does not survive a reload.
 */
export function browserRefreshTokenStorage(key = 'ab.refreshToken'): TokenStorage {
  return {
    read() {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(token: string) {
      try {
        window.localStorage.setItem(key, token);
      } catch {
        // Deliberately silent. The session is usable for this tab either way,
        // and there is nothing the person at the counter could do about it.
      }
    },
    clear() {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Nothing was stored, or nothing can be removed. Both are the goal.
      }
    },
  };
}

/** The shapes `auth.routes.ts` actually sends. */
interface LoginResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  permissions: string[];
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
}

interface MeResponse {
  user: AuthUser;
  permissions: string[];
}

/**
 * Refreshed this far ahead of expiry, so a sale started just before the deadline
 * does not meet a 401 halfway through being rung up.
 */
const DEFAULT_REFRESH_LEAD_MS = 60_000;

/**
 * Used when the API omits or sends a nonsense lifetime. Without it,
 * `setTimeout(NaN)` fires immediately and the session refreshes in a tight loop
 * until the limiter locks the counter out.
 */
const FALLBACK_ACCESS_TTL_SECONDS = 900;

/**
 * How long a cached identity may stand in for a session the server confirmed.
 *
 * Mirrors the backend's `JWT_REFRESH_TTL_DAYS` default, and `auth-session.test.ts`
 * reads that default out of `backend/src/config/index.ts` rather than restating it:
 * the two are a pair, and a longer bound here than there would leave the till
 * honouring a cached identity after the server had stopped honouring the refresh
 * token sitting beside it in `localStorage`.
 *
 * The bound covers the one case the refresh token cannot — a tablet that is never
 * reconnected. Without it a stolen device kept offline is an unlocked till
 * indefinitely; with it the cached identity expires and the login page is the only
 * way back in.
 */
export const OFFLINE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthSessionOptions {
  api: ApiClient;
  storage: TokenStorage;
  /**
   * Where the identity is cached for a restart during an outage.
   *
   * Injectable for the reason `storage` is: a test passes `memoryCache()` and never
   * touches a browser, and a browser with no IndexedDB gets the memory fallback,
   * which honestly cannot survive a reload and so simply cannot trade through a
   * restart.
   */
  sessionCache: CachePort;
  refreshLeadMs?: number;
}

export function createAuthSession(options: AuthSessionOptions): AuthSession {
  const { api, storage, sessionCache } = options;
  const refreshLeadMs = options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS;

  /**
   * Read synchronously, before the store exists, so the first state any router
   * guard sees is already the truth. Deciding it later — in `restore()`, or in
   * an effect — leaves a window in which a persisted session reports itself as
   * signed out, and a guard that reads the store inside that window sends a
   * cashier who is signed in to the login page. This is the same reason
   * zustand's `persist` middleware was not used here: its rehydration is
   * asynchronous, and that window is precisely what it opens.
   */
  const hadPersistedSession = storage.read() !== null;

  const store = createStore<AuthSessionState>()(() => ({
    // 'restoring' rather than 'signed-out': there is a token worth checking and
    // nothing has checked it yet. Those are different answers and the guard has
    // to be able to tell them apart.
    status: hadPersistedSession ? 'restoring' : 'signed-out',
    user: null,
    permissions: [],
    accessToken: null,
    accessExpiresAt: null,
    signedOutReason: 'never',
    signingIn: false,
    offline: false,
  }));

  /** The one in-flight refresh, or null. This is the coalescing. */
  let inFlight: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * True once the server itself has said this session is over, as opposed to
   * merely being unreachable. `onUnauthenticated` reads it to tell the two
   * apart, because they need opposite responses.
   */
  let serverEndedSession = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function endSession(reason: SignedOutReason): void {
    clearTimer();
    storage.clear();
    // The cached identity goes with the token, and this is the load-bearing half of
    // the offline restore: a session the server ended must not be restorable from
    // this device, or deactivating a staff member would take effect only while their
    // tablet could reach the server. Fire-and-forget because this runs on the
    // refresh-failure path where the network is already gone, and putting a sign-out
    // behind a storage write is how a tablet that cannot be signed out gets built.
    // A write that fails is not a hole either — `restore()` needs a refresh token
    // first, and that has just been cleared.
    void forgetSession(sessionCache).catch(() => {});
    store.setState({
      status: 'signed-out',
      user: null,
      permissions: [],
      accessToken: null,
      accessExpiresAt: null,
      signedOutReason: reason,
      signingIn: false,
      offline: false,
    });
  }

  function scheduleRefresh(expiresAt: number): void {
    clearTimer();
    // Clamped at zero: a token that expires inside the lead time is refreshed
    // now rather than scheduled into the past.
    const waitMs = Math.max(expiresAt - refreshLeadMs - Date.now(), 0);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, waitMs);
  }

  function applyTokens(accessToken: string, refreshToken: string, expiresInSeconds: number): void {
    const ttl = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? expiresInSeconds
      : FALLBACK_ACCESS_TTL_SECONDS;
    const expiresAt = Date.now() + ttl * 1000;
    // Written before the state is updated, so a reload at any point afterwards
    // finds the rotated token rather than the one it replaced.
    storage.write(refreshToken);
    store.setState({ accessToken, accessExpiresAt: expiresAt });
    scheduleRefresh(expiresAt);
  }

  async function performRefresh(): Promise<boolean> {
    const refreshToken = storage.read();
    if (refreshToken === null) {
      endSession('session-ended');
      return false;
    }

    try {
      const result = await api.post<RefreshResponse>(
        '/auth/refresh',
        { refreshToken },
        // Without the session: this request is the session's own renewal, and
        // sending it down the authenticated path would make a 401 answer itself.
        { withSession: false }
      );
      serverEndedSession = false;
      applyTokens(result.accessToken, result.refreshToken, result.accessExpiresInSeconds);
      // The server has just accepted this refresh token, which is the confirmation a
      // cached session was missing — a revoked, deactivated or expired session cannot
      // get one, so this is where an offline restore stops being unverified.
      //
      // Identity and permissions stay as cached until the next boot's `/auth/me`.
      // That is a UI concern and not a security one: BRIEF.md §4.1 puts enforcement
      // on every route server-side, so a stale permission only ever produces a
      // button that answers 403, and every sale this session queued is checked when
      // it is replayed. Buying fresh permissions here would mean an extra request on
      // the ordinary timed refresh, which is not a trade worth making for a case
      // that resolves on the next reload.
      if (store.getState().offline) {
        store.setState({ offline: false });
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.isAuthentication) {
        // The server said this session is over — revoked by a sign-out elsewhere,
        // a role change, a password change, or a deactivation. Nothing to retry
        // and nothing worth keeping.
        serverEndedSession = true;
        endSession(error.code === 'account_disabled' ? 'account-disabled' : 'session-ended');
        return false;
      }

      // Unreachable, rate limited, or a fault on the server. The session may well
      // still be good and the tablet may simply be offline — the state Phase 9's
      // till is built to keep selling in. Wiping the refresh token here would
      // mean a dropped mast signs the pharmacy out and strands whatever the queue
      // was holding, and the cashier would have to sign in again to recover it.
      return false;
    }
  }

  function refresh(): Promise<boolean> {
    if (inFlight !== null) return inFlight;
    inFlight = performRefresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function signIn(email: string, password: string): Promise<void> {
    store.setState({ signingIn: true });
    try {
      const result = await api.post<LoginResponse>(
        '/auth/login',
        { email, password },
        { withSession: false }
      );
      serverEndedSession = false;
      store.setState({
        status: 'signed-in',
        user: result.user,
        permissions: result.permissions,
        signedOutReason: 'never',
        signingIn: false,
        offline: false,
      });
      applyTokens(result.accessToken, result.refreshToken, result.accessExpiresInSeconds);
      // Cached for a restart during an outage. Awaited rather than fire-and-forget
      // so the write has definitely landed before the till is usable — a cache
      // written after the first navigation is a cache that may never be written at
      // all on a tablet that is closed at the end of the shift. Non-fatal: storage
      // that is full or blocked must not stop anybody signing in, it only means this
      // device cannot trade through a restart.
      await rememberSession(sessionCache, result.user, result.permissions).catch(() => {});
    } catch (error) {
      store.setState({ signingIn: false });
      // Rethrown: the sign-in form has to tell the counter "that email and
      // password do not match" from "this account has been deactivated", and
      // only the caller can put that on a screen.
      throw error;
    }
  }

  async function signOut(): Promise<void> {
    clearTimer();
    try {
      await api.post('/auth/logout');
    } catch {
      // A tablet that cannot reach the API can still sign itself out. Staying
      // signed in because the network was down is the worse failure: the next
      // person at the counter would inherit the last person's session.
    }
    // Note what this does server-side: `/auth/logout` bumps the session version,
    // which ends every session this user holds. Signing out on the dispensary
    // tablet therefore also ends the owner's laptop. That is deliberate and it is
    // the safe reading for a shared counter, but it is not what a person expects
    // from the word "logout", and the button should say who it signs out.
    endSession('signed-out');
  }

  /**
   * Puts the cached identity into the store, or answers false if there is none
   * worth using.
   *
   * Sets the identity and nothing else. In particular it leaves `accessToken` and
   * `accessExpiresAt` alone, because the two callers reach it from opposite places:
   * after a failed refresh there is no token and there should not appear to be one,
   * while after a refresh that succeeded and an `/auth/me` that did not there is a
   * perfectly good token and clearing it would throw away the one thing the server
   * had just confirmed.
   */
  async function restoreFromCache(): Promise<boolean> {
    let cached: CacheEntry<CachedSession> | null;
    try {
      cached = await readSession(sessionCache);
    } catch {
      // Storage that cannot be read must not strand the till any more than storage
      // that cannot be written. Fall through to the honest signed-out state.
      return false;
    }
    if (cached === null) return false;

    if (Date.now() - cached.fetchedAt > OFFLINE_SESSION_MAX_AGE_MS) {
      // Expired: the server has not confirmed this identity for longer than it would
      // have honoured the refresh token beside it. Dropped rather than left to be
      // re-judged on every boot.
      void forgetSession(sessionCache).catch(() => {});
      return false;
    }

    store.setState({
      status: 'signed-in',
      user: cached.value.user,
      permissions: cached.value.permissions,
      signedOutReason: 'never',
      offline: true,
    });
    return true;
  }

  async function restore(): Promise<boolean> {
    if (storage.read() === null) {
      store.setState({ status: 'signed-out', signedOutReason: 'never' });
      return false;
    }

    store.setState({ status: 'restoring' });
    const refreshed = await refresh();

    if (!refreshed) {
      // `performRefresh` has already signed out — and dropped the cached identity —
      // if the server said this session is over. Only a server that could not be
      // reached gets past that check, and it is the one case where the cache is
      // allowed to stand in for an answer.
      if (store.getState().status !== 'signed-out') {
        if (await restoreFromCache()) return true;
        // No cache, or one too old. The refresh token is kept, so the sign-in page
        // can offer to try again rather than making the cashier type a password into
        // a tablet that cannot check it.
        store.setState({ status: 'signed-out', signedOutReason: 'unreachable' });
      }
      return false;
    }

    try {
      // `/auth/refresh` returns tokens but not the person, so this is the second
      // of two requests at boot. Both are cheap: `/auth/me` is one primary-key
      // lookup and is not behind the auth limiter.
      const me = await api.get<MeResponse>('/auth/me');
      store.setState({
        status: 'signed-in',
        user: me.user,
        permissions: me.permissions,
        signedOutReason: 'never',
        offline: false,
      });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.isOffline) {
        // The connection dropped between the two requests. The cache is still the
        // right fallback and a stronger one than usual: the server confirmed this
        // session seconds ago, and the token it issued is still in the store.
        if (await restoreFromCache()) return true;
        store.setState({ status: 'signed-out', signedOutReason: 'unreachable' });
        return false;
      }
      // A token that was just issued and then refused on `/auth/me` is not a
      // network problem worth waiting out.
      endSession('session-ended');
      return false;
    }
  }

  const tokens: TokenSource = {
    getAccessToken: () => store.getState().accessToken,
    refresh,
    onUnauthenticated() {
      // `performRefresh` has already cleaned up if the server confirmed the
      // session is dead.
      if (serverEndedSession) return;
      // Otherwise the API refused our credentials without the server ever
      // confirming the session is over — the refresh could not be reached, for
      // instance. Forget the access token so the next request asks for a new one,
      // and leave the persisted session alone.
      clearTimer();
      store.setState({ accessToken: null, accessExpiresAt: null });
    },
  };

  return {
    store,
    tokens,
    api,
    signIn,
    signOut,
    restore,
    can: (permission: Permission) => store.getState().permissions.includes(permission),
    dispose: clearTimer,
  };
}

let session: AuthSession | null = null;

/**
 * The app's one session.
 *
 * Created on first use rather than at import, so importing this module in a test
 * or during a server-side render has no side effects and touches no browser
 * storage. Calling it is a different matter and is refused on the server — see
 * the guard.
 *
 * The client and the session need each other — the client asks the session for
 * tokens, and the session calls the API — so each is handed a reference that
 * resolves when it is used rather than when it is built. Neither is called
 * before both exist.
 */
export function getAuthSession(): AuthSession {
  if (typeof window === 'undefined') {
    // Refused rather than built. Module scope on the server belongs to the
    // process, not to the request, so a session created during a server render
    // would still be sitting there for the next visitor — holding the previous
    // visitor's refresh token. That is not a degraded experience, it is one
    // pharmacist's session handed to another, and it would be invisible in every
    // test that runs in a browser environment. Failing loudly here is cheaper
    // than being careful everywhere else.
    throw new Error('getAuthSession() must not be called during server rendering');
  }
  if (session !== null) return session;

  const api = createApiClient({
    baseUrl: frontendConfig.apiBaseUrl,
    tokens: {
      getAccessToken: () => session?.tokens.getAccessToken() ?? null,
      refresh: async () => (await session?.tokens.refresh()) ?? false,
      onUnauthenticated: () => session?.tokens.onUnauthenticated(),
    },
  });

  session = createAuthSession({
    api,
    storage: browserRefreshTokenStorage(),
    sessionCache: getOfflineCache(),
  });
  return session;
}

/** Tears the singleton down. Tests use it; the app never needs to. */
export function resetAuthSession(): void {
  session?.dispose();
  session = null;
}
