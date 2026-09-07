import jwt from 'jsonwebtoken';
import { config } from '../config';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  type AuthContext,
} from '../utils/jwt';

/**
 * Token signing and verification.
 *
 * The interesting failures are the cross-use ones. A refresh token that is
 * accepted as an access token turns a seven-day credential into something that
 * authorises requests directly, which is the whole reason there are two secrets
 * and a `typ` claim.
 */

const CONTEXT: AuthContext = {
  userId: 'a0000000-0000-4000-8000-000000000002',
  pharmacyId: 'a0000000-0000-4000-8000-000000000001',
  role: 'pharmacist',
  sessionVersion: 4,
};

function decode(token: string): Record<string, unknown> {
  // Decoded without verifying, because these tests assert on what a token
  // *contains* — including tokens that must not verify.
  return jwt.decode(token) as Record<string, unknown>;
}

describe('access tokens', () => {
  it('round-trips the whole auth context', () => {
    const token = signAccessToken(CONTEXT);

    expect(verifyAccessToken(token)).toEqual(CONTEXT);
  });

  it('puts the user id in the registered sub claim', () => {
    // Not a cosmetic choice: `sub` is what standard tooling, log redaction and
    // any future token introspection looks for. A custom `userId` claim is
    // invisible to all of it.
    const claims = decode(signAccessToken(CONTEXT));

    expect(claims['sub']).toBe(CONTEXT.userId);
    expect(claims['typ']).toBe('access');
    expect(claims['role']).toBe('pharmacist');
    expect(claims['sessionVersion']).toBe(4);
  });

  it('expires after the configured lifetime', () => {
    const claims = decode(signAccessToken(CONTEXT));
    const issuedAt = claims['iat'] as number;
    const expiresAt = claims['exp'] as number;

    expect(expiresAt - issuedAt).toBe(config.jwt.accessTtlSeconds);
  });

  it('carries the session version it was signed with', () => {
    // This is the value `authenticate` compares against the row. Without it,
    // revocation could only happen by waiting for expiry.
    expect(verifyAccessToken(signAccessToken({ ...CONTEXT, sessionVersion: 9 })).sessionVersion)
      .toBe(9);
  });

  it('rejects a token that has expired', () => {
    const expired = jwt.sign(
      {
        typ: 'access',
        sub: CONTEXT.userId,
        pharmacyId: CONTEXT.pharmacyId,
        role: CONTEXT.role,
        sessionVersion: CONTEXT.sessionVersion,
      },
      config.jwt.secret,
      { expiresIn: -10 }
    );

    expect(() => verifyAccessToken(expired)).toThrow();
  });

  it('rejects a token whose signature was altered', () => {
    const token = signAccessToken(CONTEXT);
    // One character of the signature swapped for another. The cheapest possible
    // forgery attempt, and it must not verify.
    const tampered = `${token.slice(0, -1)}${token.slice(-1) === 'A' ? 'B' : 'A'}`;

    expect(tampered).not.toBe(token);
    expect(() => verifyAccessToken(tampered)).toThrow();
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign(
      {
        typ: 'access',
        sub: CONTEXT.userId,
        pharmacyId: CONTEXT.pharmacyId,
        role: 'pharmacy_owner',
        sessionVersion: 0,
      },
      'a-completely-different-secret-that-is-long-enough',
      { expiresIn: 3600 }
    );

    // The payload is perfect and grants owner. Only the signature stops it.
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it('trusts the role claim, leaving authorisation to authorize', () => {
    // `verifyAccessToken` proves who is asking; it does not decide what they may
    // do. Asserting the split here documents that a token is an identity and not
    // a permission, so a role change is only meaningful once a route reads it
    // through `can`.
    const token = signAccessToken({ ...CONTEXT, role: 'pharmacy_owner' });

    expect(verifyAccessToken(token).role).toBe('pharmacy_owner');
  });
});

describe('refresh tokens', () => {
  it('round-trips the user id and session version', () => {
    const token = signRefreshToken(CONTEXT.userId, 7);

    expect(verifyRefreshToken(token)).toEqual({ userId: CONTEXT.userId, sessionVersion: 7 });
  });

  it('is not an access token, and carries no role or pharmacy', () => {
    const claims = decode(signRefreshToken(CONTEXT.userId, 7));

    expect(claims['typ']).toBe('refresh');
    // A refresh token that carried a role would be a second, longer-lived
    // authorisation credential. It carries the minimum: who, and which session.
    expect(claims['role']).toBeUndefined();
    expect(claims['pharmacyId']).toBeUndefined();
  });

  it('expires after the configured lifetime in days', () => {
    const claims = decode(signRefreshToken(CONTEXT.userId, 1));
    const issuedAt = claims['iat'] as number;
    const expiresAt = claims['exp'] as number;

    expect(expiresAt - issuedAt).toBe(config.jwt.refreshTtlDays * 24 * 60 * 60);
  });
});

describe('cross-use', () => {
  it('rejects a refresh token presented as an access token', () => {
    const refresh = signRefreshToken(CONTEXT.userId, CONTEXT.sessionVersion);

    expect(() => verifyAccessToken(refresh)).toThrow();
  });

  it('rejects an access token presented as a refresh token', () => {
    const access = signAccessToken(CONTEXT);

    expect(() => verifyRefreshToken(access)).toThrow();
  });

  it('rejects an access token signed with the refresh secret', () => {
    // The other half of the two-secret design: even with the right `typ`, the
    // wrong secret fails. Leaking one secret does not leak both credentials.
    const mislabelled = jwt.sign(
      {
        typ: 'access',
        sub: CONTEXT.userId,
        pharmacyId: CONTEXT.pharmacyId,
        role: CONTEXT.role,
        sessionVersion: CONTEXT.sessionVersion,
      },
      config.jwt.refreshSecret,
      { expiresIn: 3600 }
    );

    expect(() => verifyAccessToken(mislabelled)).toThrow();
  });

  it('rejects a correctly signed token labelled refresh, on the typ claim alone', () => {
    // The two tests above pass on the signature, so they would keep passing if
    // the `typ` check were deleted. This one is signed with the access secret —
    // the signature is valid — and is refused only because of its label. It is
    // what proves the claim is load-bearing rather than decorative.
    const wrongKind = jwt.sign(
      { typ: 'refresh', sub: CONTEXT.userId, sessionVersion: CONTEXT.sessionVersion },
      config.jwt.secret,
      { expiresIn: 3600 }
    );

    expect(() => verifyAccessToken(wrongKind)).toThrow();
  });

  it('rejects a correctly signed token labelled access, on the typ claim alone', () => {
    const wrongKind = jwt.sign(
      {
        typ: 'access',
        sub: CONTEXT.userId,
        pharmacyId: CONTEXT.pharmacyId,
        role: CONTEXT.role,
        sessionVersion: CONTEXT.sessionVersion,
      },
      config.jwt.refreshSecret,
      { expiresIn: 3600 }
    );

    expect(() => verifyRefreshToken(wrongKind)).toThrow();
  });

  it('is signed with two different secrets', () => {
    // Pinned here rather than only in config.test.ts, because everything above
    // depends on it. If this ever passes with equal secrets, every cross-use
    // assertion in this file becomes meaningless.
    expect(config.jwt.secret).not.toBe(config.jwt.refreshSecret);
  });
});
