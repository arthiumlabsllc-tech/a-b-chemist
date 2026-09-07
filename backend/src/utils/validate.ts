import { body, validationResult, type ValidationChain } from 'express-validator';
import type { Request } from 'express';
import { HttpError } from './http';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password';

/**
 * Request validation, in one shape.
 *
 * Validators run as middleware and only mark the request; nothing throws until
 * `runValidation` is called at the top of the handler. That split is what lets a
 * route declare all of its rules in one readable list above the handler instead
 * of interleaving checks with logic.
 *
 * The password limits are imported from utils/password, where the reasons for
 * them live next to the hashing that imposes them.
 */

export function runValidation(req: Request): void {
  const result = validationResult(req);
  if (result.isEmpty()) return;

  // Field paths and messages go back to the caller because they are the only
  // way the person at the counter can fix the form. Nothing else about the
  // request is echoed, and no message here may name a table, a column or a
  // constraint — that is a schema disclosure dressed up as help text.
  //
  // `mapped()` keys by field path and keeps the first error per field: a form
  // shows one message under each input, not four reasons why the same one is
  // wrong. `String()` because express-validator types `msg` as `any`.
  throw new HttpError(400, 'Some details need correcting before this can be saved', {
    code: 'validation_failed',
    details: Object.entries(result.mapped()).map(([field, error]) => ({
      field,
      message: String(error.msg),
    })),
  });
}

/**
 * The password rule, shared by staff creation and password reset so the two
 * cannot drift apart. Login deliberately does not use it: an account created
 * before the rule existed must still be able to sign in.
 */
export function strongPassword(field: string): ValidationChain {
  return body(field)
    .isString()
    .withMessage('Enter a password')
    .isLength({ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH })
    .withMessage(
      `Passwords must be at least ${MIN_PASSWORD_LENGTH} and at most ${MAX_PASSWORD_LENGTH} characters`
    );
}
