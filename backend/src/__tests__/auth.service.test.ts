jest.mock('../database/pool', () => ({
  // Mocked at the pool, not at the repository: the real SQL strings are what
  // `markLogin` and `bumpSessionVersion` are made of, and a test that replaced
  // the repository would be asserting against its own fiction.
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn(),
  probeDatabase: jest.fn().mockResolvedValue({ ok: false, error: 'unused in this suite' }),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

import bcrypt from 'bcryptjs';
import { query } from '../database/pool';
import type { UserRow } from '../repositories/users.repository';
import { login, refresh, revokeSessions, toSafeUser } from '../services/auth.service';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../utils/jwt';
import { hashPassword } from '../utils/password';

/**
 * Login, refresh and revocation, with the user lookup injected.
 *
 * What is under test is the decision table: which failures are told apart,
 * which are deliberately not, and what a session carries. None of that needs a
 * database, and a suite that needed one would not run in CI.
 */

const queryMock = query as jest.Mock;

const PASSWORD = 'counter-shift-2026';
const USER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACY_ID = 'a0000000-0000-4000-8000-000000000001';

let passwordHash = '';

beforeAll(async () => {
  // Four rounds: the suite asserts which comparisons happen, not how long they
  // take. `password.test.ts` covers the cost factor.
  passwordHash = await hashPassword(PASSWORD, 4);
});

function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    pharmacyId: PHARMACY_ID,
    fullName: 'Ama Mensah',
    email: 'ama@aandb.example',
    phone: null,
    role: 'pharmacist',
    passwordHash,
    isActive: true,
    sessionVersion: 3,
    lastLoginAt: null,
    ...overrides,
  };
}

/** True when the suite's mocked pool was asked to stamp `last_login_at`. */
function stampedLastLogin(): boolean {
  return queryMock.mock.calls.some(([text]: [string]) => text.includes('last_login_at'));
}

/** True when the mocked pool was asked to bump the session version. */
function bumpedSessionVersion(): boolean {
  return queryMock.mock.calls.some(([text]: [string]) =>
    text.includes('session_version = session_version + 1')
  );
}

/** A refresh token for `row`, signed exactly the way the service signs one. */
function refreshTokenFor(row: UserRow): string {
  return signRefreshToken(row.id, row.sessionVersion);
}

describe('toSafeUser', () => {
  it('omits the password hash and the session version', () => {
    const safe = toSafeUser(userRow());

    expect(safe).toEqual({
      id: USER_ID,
      fullName: 'Ama Mensah',
      email: 'ama@aandb.example',
      role: 'pharmacist',
      isActive: true,
    });
    // Asserted on the serialised form too: a hash leaking into a response is a
    // leak however it got into the object.
    expect(JSON.stringify(safe)).not.toContain(passwordHash);
  });
});

describe('login', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  it('issues both tokens and the safe user on correct credentials', async () => {
    const row = userRow();
    const result = await login('ama@aandb.example', PASSWORD, async () => row);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.user).toEqual(toSafeUser(row));
    expect(verifyAccessToken(result.accessToken)).toEqual({
      userId: USER_ID,
      pharmacyId: PHARMACY_ID,
      role: 'pharmacist',
      sessionVersion: 3,
    });
    expect(verifyRefreshToken(result.refreshToken)).toEqual({
      userId: USER_ID,
      sessionVersion: 3,
    });
  });

  it('stamps last_login_at on a successful login', async () => {
    await login('ama@aandb.example', PASSWORD, async () => userRow());

    // The audit trail is written on the way in, not derived later from tokens.
    expect(stampedLastLogin()).toBe(true);
  });

  it('does not stamp last_login_at on a failed login', async () => {
    await login('ama@aandb.example', 'not-the-password', async () => userRow());

    expect(stampedLastLogin()).toBe(false);
  });

  it('reports invalid_credentials for an unknown email', async () => {
    const result = await login('nobody@aandb.example', PASSWORD, async () => null);

    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('reports invalid_credentials for a wrong password, identically', async () => {
    const result = await login('ama@aandb.example', 'not-the-password', async () => userRow());

    // The two answers above must be indistinguishable, or login is a directory
    // of which email addresses belong to staff.
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('performs a bcrypt comparison even when the email is unknown', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    compare.mockClear();

    await login('nobody@aandb.example', PASSWORD, async () => null);
    const unknownEmailComparisons = compare.mock.calls.length;

    compare.mockClear();
    await login('ama@aandb.example', 'not-the-password', async () => userRow());
    const knownEmailComparisons = compare.mock.calls.length;

    compare.mockRestore();

    // Timing equality, not just answer equality. Without the throwaway
    // comparison an unknown email answers in microseconds while a known one
    // takes a hundred, and the directory is readable from a stopwatch.
    expect(unknownEmailComparisons).toBe(1);
    expect(knownEmailComparisons).toBe(1);
  });

  it('reports account_disabled for a deactivated account holding the right password', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    compare.mockClear();

    const result = await login('ama@aandb.example', PASSWORD, async () =>
      userRow({ isActive: false })
    );

    const comparisons = compare.mock.calls.length;
    compare.mockRestore();

    // The deactivation is reported before the password is even checked. Someone
    // who has been signed off needs to be told to see the owner, not to keep
    // retrying — and no comparison is spent on an account that cannot sign in.
    expect(result).toEqual({ ok: false, reason: 'account_disabled' });
    expect(comparisons).toBe(0);
  });

  it('reports password_not_set for the seeded owner', async () => {
    const result = await login('owner@localhost', PASSWORD, async () =>
      userRow({ email: 'owner@localhost', passwordHash: 'UNSET' })
    );

    // Distinct from invalid_credentials on purpose: the fix is not a better
    // recollection of the password, it is running the onboarding script.
    expect(result).toEqual({ ok: false, reason: 'password_not_set' });
  });

  it('reports password_not_set for a stored plaintext password', async () => {
    const result = await login('ama@aandb.example', PASSWORD, async () =>
      userRow({ passwordHash: PASSWORD })
    );

    // The hash column holding the password itself must not become a working
    // login, however it got there.
    expect(result).toEqual({ ok: false, reason: 'password_not_set' });
  });

  it('trims and matches the email as typed by the lookup', async () => {
    const seen: string[] = [];
    await login('  ama@aandb.example  ', PASSWORD, async (email) => {
      seen.push(email);
      return userRow();
    });

    // Trailing space from a phone keyboard is the most common reason a
    // pharmacist "cannot sign in" and the least likely to be reported as such.
    expect(seen).toEqual(['ama@aandb.example']);
  });
});

describe('refresh', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  it('issues a fresh pair for a live session', async () => {
    const row = userRow();
    const result = await refresh(refreshTokenFor(row), async () => row);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(verifyAccessToken(result.accessToken).sessionVersion).toBe(3);
  });

  it('does not stamp last_login_at', async () => {
    const row = userRow();
    await refresh(refreshTokenFor(row), async () => row);

    // A refresh is not a login. Stamping it would make "when did this person
    // last sign in" mean "when did their tablet last wake up".
    expect(stampedLastLogin()).toBe(false);
  });

  it('reads the session version from the row, not from the token', async () => {
    const staleToken = refreshTokenFor(userRow({ sessionVersion: 2 }));
    const result = await refresh(staleToken, async () => userRow({ sessionVersion: 3 }));

    // The token said 2 and was refused; a new one is issued at 3. Trusting the
    // token's own version here would make the version number decorative.
    expect(result).toEqual({ ok: false, reason: 'session_revoked' });
  });

  it('reports invalid_token for a token that does not verify', async () => {
    const result = await refresh('not-a-token', async () => userRow());

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('reports invalid_token for an access token presented as a refresh token', async () => {
    const access = signAccessToken({
      userId: USER_ID,
      pharmacyId: PHARMACY_ID,
      role: 'pharmacist',
      sessionVersion: 3,
    });

    const result = await refresh(access, async () => userRow());

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('reports account_disabled when the user is gone or deactivated', async () => {
    const token = refreshTokenFor(userRow());

    expect(await refresh(token, async () => null)).toEqual({
      ok: false,
      reason: 'account_disabled',
    });
    expect(await refresh(token, async () => userRow({ isActive: false }))).toEqual({
      ok: false,
      reason: 'account_disabled',
    });
  });
});

describe('revokeSessions', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  it('bumps the session version, which is the only revocation there is', async () => {
    await revokeSessions(USER_ID);

    expect(bumpedSessionVersion()).toBe(true);
    expect(queryMock.mock.calls[0]?.[1]).toEqual([USER_ID]);
  });
});
