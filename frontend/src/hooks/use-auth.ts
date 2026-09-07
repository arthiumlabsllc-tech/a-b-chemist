'use client';

import { useSyncExternalStore } from 'react';
import { createApiClient, type ApiClient } from '@/lib/api-client';
import {
  getAuthSession,
  type AuthSession,
  type AuthSessionState,
  type Permission,
} from '@/lib/auth-session';
import { frontendConfig } from '@/lib/frontend-config';

/**
 * The session, as a React hook.
 *
 * The session itself is a plain zustand vanilla store with no React in it, which
 * is what makes it testable without rendering anything. This file is the only
 * place the two meet, and it exists to get three things right that are easy to
 * get subtly wrong:
 *
 *  1. **A server render must not touch the session.** `getAuthSession()` refuses
 *     to run there, so this hook resolves it lazily and supplies a snapshot for
 *     the server instead.
 *  2. **The snapshot the server returns says "restoring", not "signed out".**
 *     React renders the client tree on the server first, and a route guard that
 *     read "signed out" from that pass would redirect to `/login` before the
 *     browser ever checked the persisted token — on every reload. "Restoring" is
 *     also simply the truth: the server does not know who is signed in.
 *  3. **The bearer token is not in the result.** Components have no use for it —
 *     the API client attaches it — and a type that does not offer it cannot put
 *     it in a query string, a `console.log` or an error report.
 */

/**
 * What the hook hands back.
 *
 * `accessToken` and `accessExpiresAt` are deliberately absent. See 3 above.
 */
export type UseAuthResult = Omit<AuthSessionState, 'accessToken' | 'accessExpiresAt'> & {
  /** Whether the server granted this permission to the signed-in person. */
  can(permission: Permission): boolean;
  /** Rejects with the `ApiError` the sign-in form has to read. */
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** The app's one client, so a page never builds its own. */
  api: ApiClient;
};

/**
 * The state reported while rendering on the server, and during hydration.
 *
 * A module-level constant rather than a fresh object: React requires
 * `getServerSnapshot` to return a cached value, and a new object each call makes
 * it re-render forever.
 */
const SERVER_STATE: AuthSessionState = {
  // Not 'signed-out'. See 2 in the module docstring.
  status: 'restoring',
  user: null,
  permissions: [],
  accessToken: null,
  accessExpiresAt: null,
  signedOutReason: 'never',
  signingIn: false,
  // A server render has not restored anything from a device cache, and cannot.
  offline: false,
};

/** The session on the client, and null anywhere else. */
function resolveSession(): AuthSession | null {
  if (typeof window === 'undefined') return null;
  return getAuthSession();
}

/**
 * The session, for the members that act.
 *
 * Signing in and signing out cannot happen during a server render, so rather
 * than invent a result this throws — but only when one of them is called, which
 * is always from a handler or an effect, and therefore always on the client.
 */
function actingSession(): AuthSession {
  const found = resolveSession();
  if (found === null) {
    throw new Error('The session cannot be used while rendering on the server');
  }
  return found;
}

let serverApi: ApiClient | null = null;

/**
 * Stands in for the API during a server render, where there is no session to
 * take one from.
 *
 * Inert rather than throwing. A page writes `const { api } = useAuth()` at the
 * top of its render and uses it from an effect, so a getter that threw would
 * fail the render itself while the effect that would have used it never runs at
 * all. This one carries no token and cannot refresh, so anything that somehow
 * did reach it would be refused by the API — the correct answer for a request
 * made with no session.
 *
 * Built on first use and memoised, for two reasons: importing this module stays
 * free of side effects, which is the same rule `getAuthSession()` follows; and
 * the value has to be referentially stable, because pages list `api` in their
 * effect dependencies and a new client per render would re-run every one of them
 * forever.
 */
function inertApi(): ApiClient {
  if (serverApi === null) {
    serverApi = createApiClient({
      baseUrl: frontendConfig.apiBaseUrl,
      tokens: {
        getAccessToken: () => null,
        refresh: async () => false,
        onUnauthenticated: () => {
          // Nothing to forget. There is no session on this side of the render.
        },
      },
    });
  }
  return serverApi;
}

function subscribe(onStoreChange: () => void): () => void {
  // Only ever called from an effect, so only ever on the client. The fallback is
  // here because React would treat a `subscribe` that throws as a broken store
  // rather than as the mistake it is.
  return resolveSession()?.store.subscribe(onStoreChange) ?? (() => {});
}

function getSnapshot(): AuthSessionState {
  return resolveSession()?.store.getState() ?? SERVER_STATE;
}

function getServerSnapshot(): AuthSessionState {
  return SERVER_STATE;
}

export function useAuth(): UseAuthResult {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const session = resolveSession();

  return {
    status: state.status,
    user: state.user,
    permissions: state.permissions,
    signedOutReason: state.signedOutReason,
    signingIn: state.signingIn,
    // Exposed because it is the one thing the UI has to say out loud: while it is
    // true the name on screen and the permissions gating the nav came from this
    // device's cache and the server has not confirmed them. See `auth-session.ts`.
    offline: state.offline,
    // From the rendered state rather than from the session, so what a component
    // is told it may do is always the same as what it is rendering. During
    // hydration those two briefly differ, and the state is the one on screen.
    can: (permission: Permission) => state.permissions.includes(permission),
    signIn: (email: string, password: string) => actingSession().signIn(email, password),
    signOut: () => actingSession().signOut(),
    api: session?.api ?? inertApi(),
  };
}
