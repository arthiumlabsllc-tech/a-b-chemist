jest.mock('../database/pool', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  probeDatabase: jest.fn(),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { query } from '../database/pool';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { HttpError } from '../utils/http';
import { signAccessToken, type AuthContext } from '../utils/jwt';
import type { UserRole } from '../utils/permissions';

/**
 * The two middleware every protected route depends on.
 *
 * Tested as middleware rather than through routes, because the distinction
 * between "no token", "bad token", "gone user" and "revoked session" is made
 * here and nowhere else — and because a route test would pass for the wrong
 * reason if the user lookup happened to be stubbed out.
 */

const queryMock = query as jest.Mock;

const USER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACY_ID = 'a0000000-0000-4000-8000-000000000001';

const CONTEXT: AuthContext = {
  userId: USER_ID,
  pharmacyId: PHARMACY_ID,
  role: 'pharmacist',
  sessionVersion: 3,
};

/** The row shape the repository maps: snake_case, straight from Postgres. */
function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER_ID,
    pharmacy_id: PHARMACY_ID,
    full_name: 'Ama Mensah',
    email: 'ama@aandb.example',
    phone: null,
    role: 'pharmacist',
    password_hash: 'UNSET',
    is_active: true,
    session_version: 3,
    last_login_at: null,
    ...overrides,
  };
}

/** Makes the mocked pool answer `findUserById` with `row`, or with nothing. */
function theUserIs(row: Record<string, unknown> | null): void {
  queryMock.mockResolvedValue({ rows: row === null ? [] : [row], rowCount: row === null ? 0 : 1 });
}

function fakeRequest(init: { authorization?: string; auth?: AuthContext } = {}): Request {
  const headers: Record<string, string> = {};
  if (init.authorization !== undefined) headers['authorization'] = init.authorization;
  return { headers, auth: init.auth } as unknown as Request;
}

/**
 * Runs a middleware and resolves when it calls `next`.
 *
 * If the middleware never calls next this promise never resolves and jest fails
 * the test on its timeout — which is the right outcome, because a middleware
 * that neither continues nor answers is a hung request.
 */
function run(
  middleware: RequestHandler,
  req: Request
): Promise<{ error: unknown; req: Request }> {
  return new Promise((resolve) => {
    middleware(req, {} as Response, ((error?: unknown) => {
      resolve({ error, req });
    }) as NextFunction);
  });
}

function httpErrorOf(error: unknown): { status: number; code?: string; details?: unknown } {
  expect(error).toBeInstanceOf(HttpError);
  const httpError = error as HttpError;
  return { status: httpError.status, code: httpError.code, details: httpError.details };
}

beforeEach(() => {
  queryMock.mockReset();
  theUserIs(dbRow());
});

describe('authenticate', () => {
  it('sets req.auth for a valid token from a live session', async () => {
    const req = fakeRequest({ authorization: `Bearer ${signAccessToken(CONTEXT)}` });

    const { error } = await run(authenticate, req);

    expect(error).toBeUndefined();
    expect(req.auth).toEqual(CONTEXT);
  });

  it('refuses a request with no Authorization header', async () => {
    const { error } = await run(authenticate, fakeRequest());

    expect(httpErrorOf(error)).toEqual({
      status: 401,
      code: 'not_authenticated',
      details: undefined,
    });
  });

  it('refuses a scheme that is not Bearer', async () => {
    const { error } = await run(authenticate, fakeRequest({ authorization: 'Basic dXNlcjpwYXNz' }));

    // A scheme we do not issue is not a partial success. Accepting it "just in
    // case" is how a cookie ends up authorising an API that never set one.
    expect(httpErrorOf(error).code).toBe('not_authenticated');
  });

  it.each([
    ['Bearer not-a-token', 'garbage after a correct scheme'],
    ['Bearer ', 'an empty credential'],
    [
      `Bearer ${signAccessToken({ ...CONTEXT, sessionVersion: 3 })}x`,
      'a valid token with one character appended',
    ],
  ])('refuses %s (%s) as token_invalid', async (header) => {
    const { error } = await run(authenticate, fakeRequest({ authorization: header }));

    expect(httpErrorOf(error)).toEqual({
      status: 401,
      code: 'token_invalid',
      details: undefined,
    });
  });

  it('gives a missing user and a forged token the same answer', async () => {
    theUserIs(null);
    const missingUser = await run(
      authenticate,
      fakeRequest({ authorization: `Bearer ${signAccessToken(CONTEXT)}` })
    );

    theUserIs(dbRow());
    const forged = await run(authenticate, fakeRequest({ authorization: 'Bearer abc.def.ghi' }));

    // One message for both. Telling a caller "your token is fine but we cannot
    // find you" confirms the signature is valid, which is half of what an
    // attacker probing forged tokens needs to know.
    expect(httpErrorOf(missingUser.error)).toEqual(httpErrorOf(forged.error));
    expect(httpErrorOf(missingUser.error).code).toBe('token_invalid');
  });

  it('refuses a deactivated user holding an otherwise perfect token', async () => {
    theUserIs(dbRow({ is_active: false }));

    const { error } = await run(
      authenticate,
      fakeRequest({ authorization: `Bearer ${signAccessToken(CONTEXT)}` })
    );

    // The whole point of reading the row on every request. Without it,
    // deactivation would take effect when the token expired — up to an hour
    // during which a dismissed cashier could still sell.
    expect(httpErrorOf(error).status).toBe(401);
  });

  it('refuses a session the server has since revoked', async () => {
    theUserIs(dbRow({ session_version: 4 }));

    const { error } = await run(
      authenticate,
      fakeRequest({ authorization: `Bearer ${signAccessToken(CONTEXT)}` })
    );

    expect(httpErrorOf(error)).toEqual({
      status: 401,
      code: 'session_revoked',
      details: undefined,
    });
  });

  it('accepts a role change that came with a matching session version', async () => {
    // A promoted user is re-issued a token at the new version by whoever
    // promoted them; this asserts the middleware reads the role from the token
    // and the liveness from the row, and does not mix the two up.
    theUserIs(dbRow({ role: 'pharmacy_owner', session_version: 5 }));
    const promoted: AuthContext = { ...CONTEXT, role: 'pharmacy_owner', sessionVersion: 5 };

    const { error, req } = await run(
      authenticate,
      fakeRequest({ authorization: `Bearer ${signAccessToken(promoted)}` })
    );

    expect(error).toBeUndefined();
    expect(req.auth?.role).toBe('pharmacy_owner');
  });
});

describe('requireAuth', () => {
  it('returns the context when authenticate has run', () => {
    expect(requireAuth(fakeRequest({ auth: CONTEXT }))).toBe(CONTEXT);
  });

  it('throws rather than dereferencing undefined when it has not', () => {
    // A route mounted without `authenticate` must fail loudly at the first
    // request, not read `undefined.userId` and answer a 500 that says nothing
    // about the mounting mistake that caused it.
    expect(() => requireAuth(fakeRequest())).toThrow(HttpError);
    try {
      requireAuth(fakeRequest());
    } catch (error) {
      expect(httpErrorOf(error).code).toBe('not_authenticated');
    }
  });
});

describe('authorize', () => {
  const asRole = (role: UserRole): Request => fakeRequest({ auth: { ...CONTEXT, role } });

  it('passes an owner asking for an owner-only permission', async () => {
    const { error } = await run(authorize('staff:manage'), asRole('pharmacy_owner'));

    expect(error).toBeUndefined();
  });

  it('refuses a pharmacist asking for an owner-only permission', async () => {
    const { error } = await run(authorize('staff:manage'), asRole('pharmacist'));

    expect(httpErrorOf(error)).toEqual({
      status: 403,
      code: 'forbidden',
      details: { missing: ['staff:manage'] },
    });
  });

  it('refuses counter staff asking to void a sale', async () => {
    const { error } = await run(authorize('sales:void'), asRole('staff'));

    // The named control from the brief: the person who rang up a sale must not
    // be the person who can erase it.
    expect(httpErrorOf(error).status).toBe(403);
  });

  it('allows counter staff to create a sale', async () => {
    const { error } = await run(authorize('sales:create'), asRole('staff'));

    expect(error).toBeUndefined();
  });

  it('lists exactly the permissions that are missing, and only those', async () => {
    const { error } = await run(
      authorize('sales:create', 'reports:read', 'inventory:adjust'),
      asRole('staff')
    );

    // The response names what is missing rather than a bare "no", so the UI can
    // say which of the three actions this role cannot perform.
    expect(httpErrorOf(error).details).toEqual({ missing: ['reports:read', 'inventory:adjust'] });
  });

  it('answers 401, not 403, when authenticate did not run', async () => {
    const { error } = await run(authorize('staff:manage'), fakeRequest());

    // A missing context is a mounting mistake, not a permission problem.
    // Reporting 403 here would hide the bug behind a plausible-looking answer.
    expect(httpErrorOf(error).code).toBe('not_authenticated');
  });

  it('passes when no permission is required, for any authenticated role', async () => {
    // `authorize()` with nothing required is a no-op guard. Asserted so that a
    // route using it for "authenticated, any role" behaves as written.
    for (const role of ['pharmacy_owner', 'pharmacist', 'staff'] as UserRole[]) {
      const { error } = await run(authorize(), asRole(role));
      expect(error).toBeUndefined();
    }
  });
});
