import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { HttpError, sendError } from '../utils/http';
import { scoped } from '../utils/logger';

const log = scoped('http');

/**
 * Terminal error handling.
 *
 * Everything that throws anywhere in the stack lands here, and the job is to
 * turn it into the one response shape the till understands while keeping the
 * detail in the log. The split matters: the previous build turned a Postgres
 * parse failure into a bare 500 with nothing recorded, so the failure could only
 * be diagnosed by reproducing it against production.
 */

interface PgErrorFields {
  code?: string;
  detail?: string;
  hint?: string;
  constraint?: string;
  table?: string;
  column?: string;
}

/**
 * Pulls the structured fields `pg` attaches to a database error.
 *
 * `detail` and `hint` are where Postgres explains itself — the "inconsistent
 * types deduced for parameter $19" failure carried its whole diagnosis in
 * `detail`, and a log line without it is a log line that has to be recreated.
 * Query parameters are never logged: they carry patient and payment data.
 */
function pgFields(error: unknown): PgErrorFields {
  if (typeof error !== 'object' || error === null) return {};
  const candidate = error as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof candidate[key] === 'string' ? (candidate[key] as string) : undefined;

  const fields: PgErrorFields = {
    code: pick('code'),
    detail: pick('detail'),
    hint: pick('hint'),
    constraint: pick('constraint'),
    table: pick('table'),
    column: pick('column'),
  };
  // Only a Postgres error carries these; returning an empty object for anything
  // else keeps the log line readable instead of full of undefined keys.
  return Object.values(fields).some((value) => value !== undefined) ? fields : {};
}

function expressBodyErrorType(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const type = (error as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : undefined;
}

export function notFoundHandler(req: Request, res: Response): void {
  // Echoing the method and path back is deliberate: a mistyped route in the
  // frontend shows up in the network tab as something a person can act on,
  // rather than as an HTML 404 page that says nothing about the API.
  sendError(res, 404, `No route matches ${req.method} ${req.originalUrl}`, {
    code: 'not_found',
  });
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Headers already went out — a stream that failed halfway. Writing a body now
  // would corrupt the response, so hand it to Express's default handler.
  if (res.headersSent) {
    _next(error);
    return;
  }

  const context = {
    method: req.method,
    path: req.originalUrl,
    database: pgFields(error),
  };

  if (error instanceof HttpError) {
    if (error.status >= 500) {
      log.error(error.message, { ...context, code: error.code, stack: error.stack });
    } else {
      // A 4xx is the API working as designed. Logging it as an error fills the
      // stream with noise that hides the real failures.
      log.warn(error.message, { ...context, code: error.code });
    }
    sendError(res, error.status, error.message, {
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return;
  }

  const bodyType = expressBodyErrorType(error);
  if (bodyType === 'entity.parse.failed') {
    log.warn('malformed JSON body', context);
    sendError(res, 400, 'Request body is not valid JSON', { code: 'invalid_json' });
    return;
  }
  if (bodyType === 'entity.too.large') {
    log.warn('request body too large', context);
    sendError(res, 413, 'Request body is too large', { code: 'payload_too_large' });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  log.error('unhandled error', {
    ...context,
    message,
    stack: error instanceof Error ? error.stack : undefined,
  });

  // The real message stays in the log and never reaches the client in
  // production. Postgres errors name tables, columns and constraints, which is
  // a schema disclosure to anyone who can trigger one — and it is no use to the
  // cashier either, who needs to know the sale did not go through, not why.
  sendError(
    res,
    500,
    config.isProduction ? 'Something went wrong while processing that request' : message,
    { code: 'internal_error' }
  );
}
