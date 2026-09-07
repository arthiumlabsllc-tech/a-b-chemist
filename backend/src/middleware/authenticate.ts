import type { NextFunction, Request, Response } from 'express';
import { findUserById } from '../repositories/users.repository';
import { asyncHandler } from '../utils/async-handler';
import { HttpError } from '../utils/http';
import { verifyAccessToken, type AuthContext } from '../utils/jwt';

/**
 * Turns a Bearer token into `req.auth`, or a 401.
 *
 * The token alone is not enough: it is verified, then the user row is read and
 * the session version compared. That single primary-key lookup per request is
 * what makes deactivation, role changes and password resets take effect
 * immediately — a till that keeps selling after the cashier was deactivated is
 * a till the owner cannot trust.
 */
export const authenticate = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new HttpError(401, 'Authentication required', {
        code: 'not_authenticated',
      });
    }

    let context;
    try {
      context = verifyAccessToken(header.slice('Bearer '.length));
    } catch {
      // One message for forged, expired and wrong-kind tokens: telling an
      // attacker which of the three they achieved is a free oracle.
      throw new HttpError(401, 'Session expired or invalid. Sign in again.', {
        code: 'token_invalid',
      });
    }

    const user = await findUserById(context.userId);
    if (user === null || !user.isActive) {
      throw new HttpError(401, 'Session expired or invalid. Sign in again.', {
        code: 'token_invalid',
      });
    }
    if (user.sessionVersion !== context.sessionVersion) {
      throw new HttpError(
        401,
        'This session was ended by a sign-out, role change or password change. Sign in again.',
        { code: 'session_revoked' }
      );
    }

    req.auth = context;
    next();
  }
);

/**
 * Reads the context `authenticate` put on the request.
 *
 * `req.auth` is optional on the type because Express does not know which
 * routers mounted the middleware, and a non-null assertion at every use would
 * turn that unknown into a crash. This makes the unknown a 401 instead: a route
 * that forgot to mount `authenticate` reports itself rather than dereferencing
 * undefined in front of a customer.
 */
export function requireAuth(req: Request): AuthContext {
  const auth = req.auth;
  if (auth === undefined) {
    throw new HttpError(401, 'Authentication required', { code: 'not_authenticated' });
  }
  return auth;
}
