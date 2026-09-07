import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { getAuthSession, resetAuthSession } from '@/lib/auth-session';
import { SessionBootstrap, resetSessionBootstrap } from '../session-bootstrap';

/**
 * The one effect that turns a persisted refresh token back into a session.
 *
 * Small component, but the failure it guards is not small: `reactStrictMode` is
 * on, so in development every effect runs, cleans up and runs again. Without the
 * module-level flag the boot restore would fire twice per page load — two
 * `/auth/me` calls on every screen of a till that people reload all day.
 */

/**
 * jsdom has no `fetch` and `createApiClient` reads the global when it is built.
 * Nothing here makes a request, so it only has to exist.
 */
const fetchStub = (() => Promise.reject(new Error('no request expected'))) as unknown as typeof fetch;

beforeEach(() => {
  globalThis.fetch = fetchStub;
  window.localStorage.clear();
  resetSessionBootstrap();
});

afterEach(() => {
  resetAuthSession();
  delete (globalThis as { fetch?: unknown }).fetch;
});

function restoreSpy() {
  return jest.spyOn(getAuthSession(), 'restore').mockResolvedValue(false);
}

describe('booting the session', () => {
  it('restores the persisted session when the app mounts', () => {
    const restore = restoreSpy();

    render(<SessionBootstrap />);

    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('restores once, though StrictMode runs every effect twice', () => {
    const restore = restoreSpy();

    render(
      <StrictMode>
        <SessionBootstrap />
      </StrictMode>
    );

    // One renewal, not two. The refresh itself is coalesced, so the token
    // rotation would survive this — but `/auth/me` would go twice, and the
    // ten-per-quarter-hour allowance that `/auth/refresh` shares with
    // `/auth/login` is the thing the counter cannot afford to spend carelessly.
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('does not restore again when another part of the tree mounts', () => {
    const restore = restoreSpy();

    render(<SessionBootstrap />);
    render(<SessionBootstrap />);

    // A second mount is not only StrictMode: any future layout that includes the
    // bootstrap twice would otherwise double every boot request.
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('renders nothing', () => {
    restoreSpy();

    const { container } = render(<SessionBootstrap />);

    expect(container).toBeEmptyDOMElement();
  });
});
