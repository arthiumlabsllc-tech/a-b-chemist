import { act, renderHook } from '@testing-library/react';
import { frontendConfig } from '@/lib/frontend-config';
import { getAuthSession, resetAuthSession, type AuthUser } from '@/lib/auth-session';
import { useAuth } from '../use-auth';

/**
 * The hook that binds the session to React.
 *
 * The session's own behaviour is covered in `auth-session.test.ts`, so what is
 * worth proving here is the binding: that a store change reaches a component,
 * that the bearer token never reaches one, and that the client handed to a page
 * is stable enough to sit in an effect's dependencies.
 *
 * The server-render path is in `use-auth.server.test.tsx`, which runs in a node
 * environment because jsdom cannot import `react-dom/server`.
 */

const USER: AuthUser = {
  id: 'u-1',
  fullName: 'Ama Mensah',
  email: 'ama@aandb.example',
  role: 'pharmacist',
  isActive: true,
};

const LOGIN = {
  user: USER,
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessExpiresInSeconds: 900,
  permissions: ['sales:create', 'sales:read'],
};

interface Recorded {
  method: string;
  path: string;
}

/**
 * A `fetch` that answers from a route table.
 *
 * Only what the client actually reads is faked — `status`, `ok` and `text()`.
 * Faking more than the code under test uses is how a fake drifts from the real
 * API and the test keeps passing against something no browser provides.
 */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Recorded[] = [];
  const base = frontendConfig.apiBaseUrl;

  const impl = (async (url: string, init: RequestInit = {}) => {
    const full = String(url);
    const path = full.startsWith(base) ? full.slice(base.length) : full;
    const method = String(init.method ?? 'GET');
    calls.push({ method, path });

    const data = routes[`${method} ${path}`] ?? routes[path];
    if (data === undefined) throw new Error(`no route for ${method} ${path}`);

    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ success: true, data }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return {
    impl,
    count: (path: string) => calls.filter((call) => call.path === path).length,
  };
}

let routes: ReturnType<typeof fakeFetch>;

beforeEach(() => {
  routes = fakeFetch({
    'POST /auth/login': LOGIN,
    'POST /auth/logout': { signedOut: true },
    '/auth/refresh': {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessExpiresInSeconds: 900,
    },
  });
  // Set before anything builds a client: `createApiClient` reads the global when
  // it is constructed, not when it is used.
  globalThis.fetch = routes.impl;
  window.localStorage.clear();
});

afterEach(() => {
  // Disposes the scheduled refresh the signed-in tests leave running, and drops
  // the singleton so the next test builds one against its own fetch.
  resetAuthSession();
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('reflecting the session', () => {
  it('re-renders a component when the store changes', () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.status).toBe('signed-out');

    act(() => {
      getAuthSession().store.setState({
        status: 'signed-in',
        user: USER,
        permissions: ['sales:create'],
      });
    });

    expect(result.current.status).toBe('signed-in');
    expect(result.current.user).toEqual(USER);
  });

  it('answers `can` from the permissions the server granted', () => {
    const { result } = renderHook(() => useAuth());

    act(() => {
      getAuthSession().store.setState({ permissions: ['sales:create', 'sales:read'] });
    });

    expect(result.current.can('sales:create')).toBe(true);
    // Counter staff cannot void a sale. The till has to know that before it
    // offers the button, not after the server refuses it.
    expect(result.current.can('sales:void')).toBe(false);
  });

  it('signs in through the session', async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn('ama@aandb.example', 'correct horse');
    });

    // The whole chain — hook, session, client, fetch — rather than a stubbed
    // session, because the wiring is the thing most likely to be wrong.
    expect(routes.count('/auth/login')).toBe(1);
    expect(result.current.status).toBe('signed-in');
    expect(result.current.user?.fullName).toBe('Ama Mensah');
    expect(result.current.can('sales:create')).toBe(true);
  });

  it('signs out through the session', async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn('ama@aandb.example', 'correct horse');
    });
    await act(async () => {
      await result.current.signOut();
    });

    expect(routes.count('/auth/logout')).toBe(1);
    expect(result.current.status).toBe('signed-out');
    expect(result.current.signedOutReason).toBe('signed-out');
    expect(result.current.can('sales:create')).toBe(false);
  });
});

describe('what a component is given', () => {
  it('is never handed the bearer token', () => {
    const { result } = renderHook(() => useAuth());

    act(() => {
      getAuthSession().store.setState({ accessToken: 'access-1', accessExpiresAt: Date.now() });
    });

    // Checked at runtime as well as in the type, because the type is one
    // refactor away from widening. The access token is what authorises a sale;
    // a component that can read it can put it in a query string, and the API
    // client already attaches it to every request.
    expect('accessToken' in result.current).toBe(false);
    expect('accessExpiresAt' in result.current).toBe(false);
    expect(JSON.stringify(result.current)).not.toContain('access-1');
  });

  it('hands back the same client on every render', () => {
    const { result, rerender } = renderHook(() => useAuth());
    const first = result.current.api;

    rerender();
    rerender();

    // Pages list `api` in their effect dependencies. A new client per render
    // would re-run every one of them on every render, which is a request storm
    // that looks like a slow API rather than a broken dependency array.
    expect(result.current.api).toBe(first);
    expect(first).toBe(getAuthSession().api);
  });
});
