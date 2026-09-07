import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { UserRole } from './permissions';

/**
 * Access and refresh tokens.
 *
 * Two secrets and a `typ` claim, so a refresh token presented as an access
 * token fails verification rather than quietly authorising. One secret for
 * both would turn a stolen hour-long access token into a seven-day one.
 *
 * Tokens carry the session version they were signed with. The server compares
 * it on every request, which is what makes deactivation and password resets
 * take effect immediately instead of at expiry.
 */

export interface AuthContext {
  userId: string;
  pharmacyId: string;
  role: UserRole;
  sessionVersion: number;
}

interface AccessClaims {
  typ: 'access';
  /** Registered claim name: this is the user id. */
  sub: string;
  pharmacyId: string;
  role: UserRole;
  sessionVersion: number;
}

interface RefreshClaims {
  typ: 'refresh';
  sub: string;
  sessionVersion: number;
}

export function signAccessToken(context: AuthContext): string {
  const payload: AccessClaims = {
    typ: 'access',
    sub: context.userId,
    pharmacyId: context.pharmacyId,
    role: context.role,
    sessionVersion: context.sessionVersion,
  };
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.accessTtlSeconds,
  });
}

export function signRefreshToken(userId: string, sessionVersion: number): string {
  const payload: RefreshClaims = { typ: 'refresh', sub: userId, sessionVersion };
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: `${config.jwt.refreshTtlDays}d`,
  });
}

/**
 * Verifies signature, expiry and token kind. Throws for anything else — a
 * forged, expired, wrong-secret or wrong-kind token is the same answer to the
 * caller: not authenticated.
 */
export function verifyAccessToken(token: string): AuthContext {
  const claims = jwt.verify(token, config.jwt.secret) as AccessClaims;
  if (claims.typ !== 'access') {
    throw new jwt.JsonWebTokenError('not an access token');
  }
  return {
    userId: claims.sub,
    pharmacyId: claims.pharmacyId,
    role: claims.role,
    sessionVersion: claims.sessionVersion,
  };
}

export function verifyRefreshToken(
  token: string
): { userId: string; sessionVersion: number } {
  const claims = jwt.verify(token, config.jwt.refreshSecret) as RefreshClaims;
  if (claims.typ !== 'refresh') {
    throw new jwt.JsonWebTokenError('not a refresh token');
  }
  return { userId: claims.sub, sessionVersion: claims.sessionVersion };
}
