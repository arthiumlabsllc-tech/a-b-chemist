import {
  bumpSessionVersion,
  findUserByEmail,
  findUserById,
  markLogin,
  type UserRow,
} from '../repositories/users.repository';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/jwt';
import { hashPassword, isBcryptHash, verifyPassword } from '../utils/password';
import type { UserRole } from '../utils/permissions';

/**
 * Login, refresh and revocation.
 *
 * The user lookup is a parameter with a repository default so the logic —
 * which failures are distinguishable, what a token carries, when a session
 * dies — is testable without a database, while production wires the real one.
 */

export interface SafeUser {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  isActive: boolean;
}

export function toSafeUser(row: UserRow): SafeUser {
  // passwordHash is deliberately absent from the type, so a route cannot echo
  // it without a compile error.
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    role: row.role,
    isActive: row.isActive,
  };
}

export type LoginFailureReason =
  | 'invalid_credentials'
  | 'account_disabled'
  | 'password_not_set';

export type LoginResult =
  | { ok: true; accessToken: string; refreshToken: string; user: SafeUser }
  | { ok: false; reason: LoginFailureReason };

export type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; reason: 'invalid_token' | 'account_disabled' | 'session_revoked' };

let dummyHash: string | null = null;

/**
 * A hash to compare against when the email is unknown, so an unknown account
 * and a wrong password cost the same bcrypt work. Without it, login is an
 * oracle for which emails exist in the pharmacy's staff list.
 */
async function unusedHash(): Promise<string> {
  if (dummyHash === null) {
    dummyHash = await hashPassword('timing-equaliser', 10);
  }
  return dummyHash;
}

function issueTokens(row: UserRow): { accessToken: string; refreshToken: string } {
  return {
    accessToken: signAccessToken({
      userId: row.id,
      pharmacyId: row.pharmacyId,
      role: row.role,
      sessionVersion: row.sessionVersion,
    }),
    refreshToken: signRefreshToken(row.id, row.sessionVersion),
  };
}

export async function login(
  email: string,
  password: string,
  lookup: (email: string) => Promise<UserRow | null> = findUserByEmail
): Promise<LoginResult> {
  const row = await lookup(email.trim());

  if (row === null) {
    await verifyPassword(password, await unusedHash());
    return { ok: false, reason: 'invalid_credentials' };
  }

  // Checked before the password: a deactivated account is not a secret, and
  // telling the counter "ask the owner" is more useful than "wrong password".
  if (!row.isActive) {
    return { ok: false, reason: 'account_disabled' };
  }

  if (!isBcryptHash(row.passwordHash)) {
    // The seeded owner, before onboarding set a password. Not "wrong
    // password": there is no password to be wrong about.
    return { ok: false, reason: 'password_not_set' };
  }

  const matches = await verifyPassword(password, row.passwordHash);
  if (!matches) {
    return { ok: false, reason: 'invalid_credentials' };
  }

  await markLogin(row.id);
  return { ok: true, ...issueTokens(row), user: toSafeUser(row) };
}

export async function refresh(
  refreshToken: string,
  lookup: (id: string) => Promise<UserRow | null> = findUserById
): Promise<RefreshResult> {
  let claims: { userId: string; sessionVersion: number };
  try {
    claims = verifyRefreshToken(refreshToken);
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }

  const row = await lookup(claims.userId);
  if (row === null || !row.isActive) {
    return { ok: false, reason: 'account_disabled' };
  }
  if (row.sessionVersion !== claims.sessionVersion) {
    return { ok: false, reason: 'session_revoked' };
  }

  return { ok: true, ...issueTokens(row) };
}

/** Sign-out, deactivation and password reset all end here. */
export async function revokeSessions(userId: string): Promise<void> {
  await bumpSessionVersion(userId);
}
