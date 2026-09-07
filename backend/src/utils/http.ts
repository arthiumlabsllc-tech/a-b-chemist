import type { Response } from 'express';

/**
 * The response envelope and the error type.
 *
 * One shape for every endpoint, because a till that has to guess whether a
 * failure arrives as `{ success: false }`, `{ error }` or a bare string is a
 * till that mishandles one of them. The offline queue in particular decides
 * whether to retry based on this shape, and a wrong guess there is either a
 * duplicated sale or a lost one.
 */

export interface ErrorBody {
  success: false;
  error: {
    message: string;
    /** A stable machine-readable label. The message is for humans and may change. */
    code?: string;
    /** Field-level detail from validation, safe to show at the counter. */
    details?: unknown;
  };
}

export interface SuccessBody<T> {
  success: true;
  data: T;
}

/**
 * An error with an HTTP status attached, so a route can `throw` rather than
 * remember to return after responding. Anything that is not an `HttpError`
 * reaching the handler is treated as a 500 and its message is withheld in
 * production.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    status: number,
    message: string,
    options: { code?: string; details?: unknown } = {}
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code;
    this.details = options.details;
    // Restores the prototype chain when this is compiled down to ES5-style
    // helpers, without which `instanceof HttpError` is false in the handler and
    // every deliberate 4xx is reported as a 500.
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

/**
 * The 404 a service throws when a row is not there — or is there and belongs to
 * another pharmacy.
 *
 * One message for both, deliberately. Telling a caller "no such id" in one case
 * and "that id belongs to somebody else" in the other hands them a way to
 * enumerate which ids exist in other tenants, and nobody at a counter needs that.
 * Every lookup here is scoped by `pharmacy_id` in its `where` clause, so the two
 * cases reach this function indistinguishable and leave it that way.
 *
 * Exported rather than written per service so the reasoning is in one place: it
 * is the kind of comment that gets dropped when a helper is copied.
 */
export function notFound(what: string): HttpError {
  return new HttpError(404, `No ${what} matches that id`, { code: 'not_found' });
}

export function sendOk<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data } satisfies SuccessBody<T>);
}

export function sendError(
  res: Response,
  status: number,
  message: string,
  options: { code?: string; details?: unknown } = {}
): void {
  const body: ErrorBody = {
    success: false,
    error: {
      message,
      ...(options.code === undefined ? {} : { code: options.code }),
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
  res.status(status).json(body);
}
