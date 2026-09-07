import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import { config } from '../config';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { findUserById } from '../repositories/users.repository';
import {
  login,
  refresh,
  revokeSessions,
  toSafeUser,
  type LoginFailureReason,
} from '../services/auth.service';
import { asyncHandler } from '../utils/async-handler';
import { HttpError, sendError, sendOk } from '../utils/http';
import { permissionsFor } from '../utils/permissions';
import { runValidation } from '../utils/validate';

/**
 * Signing in, and the session afterwards.
 *
 * Two routers rather than one, so that `PUBLIC_ROUTE_PREFIXES` in routes/index.ts
 * is a true description of the mount table: everything in `publicAuthRoutes`
 * answers without a token, and nothing in `sessionAuthRoutes` can.
 *
 * There is no `/register`. This is one pharmacy; an open registration route on
 * a system that holds patient records would be the first thing an attacker
 * looked for and the easiest way to end up with a stranger holding a staff
 * token.
 */

/**
 * Ten attempts per quarter hour, counted per client.
 *
 * `trust proxy` in app.ts is what makes the client the customer's device rather
 * than Render's forwarder. Without it this is not a brute-force defence, it is
 * a switch that turns the pharmacy off after ten attempts by anybody — including
 * one cashier who cannot remember whether the password ends in a full stop.
 *
 * Successful attempts count too. A limiter that resets on success is a limiter
 * an attacker drives with one valid account while guessing at another.
 */
const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) =>
    sendError(res, 429, 'Too many sign-in attempts. Wait a moment and try again.', {
      code: 'rate_limited',
    }),
});

/**
 * Which status each login failure gets, and why they are not all 401.
 *
 * `invalid_credentials` stays deliberately vague — it is the answer for an
 * unknown email and for a wrong password alike, so login cannot be used to
 * discover which addresses are on the staff list. The other two are not
 * secrets: a deactivated account and an account that has never been given a
 * password both need the person at the counter to go and find the owner, and
 * "wrong password" would send them retrying instead.
 */
const LOGIN_FAILURES: Record<LoginFailureReason, { status: number; message: string }> = {
  invalid_credentials: {
    status: 401,
    message: 'That email and password do not match our records',
  },
  account_disabled: {
    status: 403,
    message: 'This account has been deactivated. Speak to the owner.',
  },
  password_not_set: {
    status: 403,
    message: 'No password has been set for this account yet. Ask the owner to finish setting it up.',
  },
};

export const publicAuthRoutes = Router();

publicAuthRoutes.post(
  '/login',
  authLimiter,
  body('email')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('Enter the email address on your staff record'),
  // No complexity rule here on purpose: see `strongPassword` in utils/validate.
  body('password').isString().notEmpty().withMessage('Enter your password'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const { email, password } = req.body as { email: string; password: string };

    const result = await login(email, password);
    if (!result.ok) {
      const failure = LOGIN_FAILURES[result.reason];
      throw new HttpError(failure.status, failure.message, { code: result.reason });
    }

    sendOk(res, {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      // The till keeps the access token in memory and schedules its own refresh.
      // It reads the lifetime from here rather than hard-coding an hour, so
      // changing JWT_ACCESS_TTL_SECONDS does not silently desynchronise the two.
      accessExpiresInSeconds: config.jwt.accessTtlSeconds,
      permissions: permissionsFor(result.user.role),
    });
  })
);

publicAuthRoutes.post(
  '/refresh',
  authLimiter,
  body('refreshToken').isString().notEmpty().withMessage('A refresh token is required'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const { refreshToken } = req.body as { refreshToken: string };

    const result = await refresh(refreshToken);
    if (!result.ok) {
      // A revoked session is 401 so the offline queue treats it as "sign in
      // again" rather than retrying forever; a deactivated account is 403 for
      // the same reason login uses it.
      const status = result.reason === 'account_disabled' ? 403 : 401;
      const message =
        result.reason === 'account_disabled'
          ? 'This account has been deactivated. Speak to the owner.'
          : 'This session has ended. Sign in again.';
      throw new HttpError(status, message, { code: result.reason });
    }

    // Rotated: the caller swaps both tokens. The old refresh token is not
    // blacklisted, because there is no token store to blacklist it in — what
    // ends a session here is the version number, not a list. Presenting the old
    // one still works until it expires, and stops working the moment the
    // account is deactivated, the role changes or the password is reset.
    sendOk(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessExpiresInSeconds: config.jwt.accessTtlSeconds,
    });
  })
);

export const sessionAuthRoutes = Router();

sessionAuthRoutes.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);

    // Ends every session this user holds, not just the one that asked. There is
    // no per-token store, so this is what signing out can honestly mean — and on
    // a shared counter it is the safer reading: a tablet left signed in at the
    // dispensary stops working the moment anyone signs out on it.
    await revokeSessions(auth.userId);

    sendOk(res, { signedOut: true });
  })
);

sessionAuthRoutes.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);

    // Read fresh rather than served from the token: `authenticate` has already
    // proved the session is live, and this is where the frontend picks up the
    // name and permissions it renders the navigation from. One primary-key
    // lookup, on a page that is fetched once per sign-in.
    const row = await findUserById(auth.userId);
    if (row === null || !row.isActive) {
      throw new HttpError(401, 'Session expired or invalid. Sign in again.', {
        code: 'token_invalid',
      });
    }

    sendOk(res, { user: toSafeUser(row), permissions: permissionsFor(row.role) });
  })
);
