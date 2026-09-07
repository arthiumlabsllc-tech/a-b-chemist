jest.mock('../config', () => ({
  // A mutable stand-in rather than two files. The policy under test is one
  // `config.isProduction ? generic : message`, and proving both halves needs both
  // values; `jest.resetModules` plus a second `doMock` would rebuild the handler
  // for each test and the rebuild is the thing most likely to go quietly wrong.
  config: { nodeEnv: 'production', isProduction: true, isTest: false },
}));

jest.mock('../database/pool', () => ({
  query: jest.fn(),
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
  withSavepoint: jest.fn(),
  probeDatabase: jest.fn(),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { errorHandler, notFoundHandler } from '../middleware/error';
import { HttpError } from '../utils/http';

/**
 * The last thing that runs before a failure reaches the browser.
 *
 * Everything downstream of the routes is asserted through them: the envelope, the
 * status codes, the codes. What is *not* visible from a route test running under
 * jest is the one branch that depends on `config.isProduction` — whether the
 * driver's own words travel to the caller. `config.isProduction` is false for
 * every suite in this project, pinned that way by `jest.setup.js`, so the
 * production half of the handler has never been executed by anything until here.
 *
 * That half is the security-relevant one. A Postgres error carries `table`,
 * `column`, `constraint` and `detail`, and `detail` is where Postgres explains
 * itself — the "inconsistent types deduced for parameter $19" failure carried its
 * whole diagnosis there. Published from a live instance, that is a schema
 * disclosure to anyone who can trigger one, and it is no use to the cashier
 * either, who needs to know the sale did not go through and not why.
 */

const WITHHELD = 'Something went wrong while processing that request';

interface Written {
  status: number | undefined;
  body: unknown;
}

/** The chain `sendError` writes through. Declared so `res` can refer to itself. */
interface Chain {
  headersSent: boolean;
  status(code: number): Chain;
  json(payload: unknown): Chain;
}

/**
 * A `Response` that records what was written rather than sending it.
 *
 * `status().json()` is the chain `sendError` uses, and both halves are recorded
 * separately because a handler that answered 200 with the right body, or 500 with
 * no body at all, would be a different bug and the assertions below need to tell
 * them apart.
 */
function fakeResponse(init: { headersSent?: boolean } = {}): {
  res: Response;
  written: Written;
} {
  const written: Written = { status: undefined, body: undefined };
  const res: Chain = {
    headersSent: init.headersSent ?? false,
    status(code: number): Chain {
      written.status = code;
      return res;
    },
    json(payload: unknown): Chain {
      written.body = payload;
      return res;
    },
  };
  return { res: res as unknown as Response, written };
}

function fakeRequest(init: Partial<{ method: string; originalUrl: string }> = {}): Request {
  return {
    method: init.method ?? 'GET',
    originalUrl: init.originalUrl ?? '/reports/sales?from=2026-09-01',
  } as unknown as Request;
}

/** Runs the handler and answers with what it wrote, or with what it forwarded. */
function handle(
  error: unknown,
  init: { headersSent?: boolean } = {}
): { written: Written; forwarded: unknown; nextCalls: number } {
  const { res, written } = fakeResponse(init);
  let forwarded: unknown;
  let nextCalls = 0;
  const next = ((value?: unknown) => {
    nextCalls += 1;
    forwarded = value;
  }) as NextFunction;

  errorHandler(error, fakeRequest(), res, next);
  return { written, forwarded, nextCalls };
}

/** A `pg` error: a plain `Error` with the structured fields the driver attaches. */
function pgError(): Error {
  const error = new Error(
    'duplicate key value violates unique constraint "sale_payments_momo_reference_key"'
  ) as Error & Record<string, unknown>;
  error.code = '23505';
  error.table = 'sale_payments';
  error.column = 'momo_reference';
  error.constraint = 'sale_payments_momo_reference_key';
  error.detail = 'Key (momo_reference)=(ref_9f3k) already exists.';
  return error;
}

beforeEach(() => {
  (config as { isProduction: boolean }).isProduction = true;
});

describe('an unexpected error in production', () => {
  it('answers 500 in the one envelope, with a message the API wrote', () => {
    const { written } = handle(new Error('connection terminated'));

    expect(written.status).toBe(500);
    expect(written.body).toEqual({
      success: false,
      error: { message: WITHHELD, code: 'internal_error' },
    });
  });

  it('publishes nothing a driver said, anywhere in the body', () => {
    // The whole body is checked rather than the message field, because the leak
    // that matters is not a mistaken `message:` — it is a `details:` somebody
    // added later to be helpful. Stringifying is blunt and that is the point:
    // blunt assertions catch the shape nobody thought to write.
    const { written } = handle(pgError());
    const published = JSON.stringify(written.body);

    for (const secret of [
      'sale_payments',
      'momo_reference',
      'sale_payments_momo_reference_key',
      'ref_9f3k',
      'duplicate key',
      '23505',
    ]) {
      expect(published).not.toContain(secret);
    }
    expect(published).toBe(JSON.stringify({ success: false, error: { message: WITHHELD, code: 'internal_error' } }));
  });

  it('gives a non-Error the same treatment rather than throwing on the way out', () => {
    for (const thrown of ['a bare string', 42, null, undefined, { code: '23505' }]) {
      const { written } = handle(thrown);
      expect(written.status).toBe(500);
      expect(JSON.stringify(written.body)).not.toContain('23505');
    }
  });

  it('hands off when headers already went out, rather than corrupting the response', () => {
    const failure = new Error('stream closed halfway');
    const { written, forwarded, nextCalls } = handle(failure, { headersSent: true });

    // A body written after a 200 and half a payload would be a corrupted response
    // the till tries to parse. Express's own default handler is the right answer.
    expect(nextCalls).toBe(1);
    expect(forwarded).toBe(failure);
    expect(written.status).toBeUndefined();
    expect(written.body).toBeUndefined();
  });
});

describe('the same error outside production', () => {
  beforeEach(() => {
    (config as { isProduction: boolean }).isProduction = false;
  });

  it('lets the real message through, because a developer debugging blind is the other failure', () => {
    const { written } = handle(new Error('connection terminated'));

    expect(written.status).toBe(500);
    expect((written.body as { error: { message: string } }).error.message).toBe(
      'connection terminated'
    );
  });

  it('is the branch this whole suite exists to pin, and the two halves differ only in the message', () => {
    (config as { isProduction: boolean }).isProduction = true;
    const production = handle(new Error('connection terminated')).written.body;
    (config as { isProduction: boolean }).isProduction = false;
    const development = handle(new Error('connection terminated')).written.body;

    expect(production).not.toEqual(development);
    expect(production).toEqual({ success: false, error: { message: WITHHELD, code: 'internal_error' } });
    expect(development).toEqual({
      success: false,
      error: { message: 'connection terminated', code: 'internal_error' },
    });
  });
});

describe('a refusal the API wrote itself', () => {
  it('travels with its own message and details, in production too', () => {
    // An `HttpError` message is a sentence written for the caller — "Enter both
    // dates as YYYY-MM-DD" — so withholding it would be withholding the fix.
    const { written } = handle(
      new HttpError(400, 'Enter both dates as YYYY-MM-DD', {
        code: 'invalid_range',
        details: [{ field: 'from', message: 'Enter the start date as YYYY-MM-DD' }],
      })
    );

    expect(written.status).toBe(400);
    expect(written.body).toEqual({
      success: false,
      error: {
        message: 'Enter both dates as YYYY-MM-DD',
        code: 'invalid_range',
        details: [{ field: 'from', message: 'Enter the start date as YYYY-MM-DD' }],
      },
    });
  });

  it('omits a code and a details field it was not given, rather than sending them as null', () => {
    const { written } = handle(new HttpError(409, 'That basket is already settled'));
    expect(written.body).toEqual({
      success: false,
      error: { message: 'That basket is already settled' },
    });
  });

  it('answers a malformed JSON body as a 400 the form can act on', () => {
    const parseFailure = Object.assign(new Error('Unexpected token o in JSON at position 1'), {
      type: 'entity.parse.failed',
    });
    const { written } = handle(parseFailure);

    // A till that posted a truncated body from a dropped connection needs a 400 to
    // know the request never landed, and a 500 to know it might have. Guessing
    // wrong in the offline queue is a duplicated sale.
    expect(written.status).toBe(400);
    expect(written.body).toEqual({
      success: false,
      error: { message: 'Request body is not valid JSON', code: 'invalid_json' },
    });
  });

  it('answers an oversized body as a 413, and says so in words', () => {
    const { written } = handle(
      Object.assign(new Error('request entity too large'), { type: 'entity.too.large' })
    );

    expect(written.status).toBe(413);
    expect((written.body as { error: { code: string } }).error.code).toBe('payload_too_large');
  });
});

describe('a path that does not exist', () => {
  it('names the method and the path, so a mistyped route in the frontend is actionable', () => {
    const { res, written } = fakeResponse();
    notFoundHandler(fakeRequest({ method: 'POST', originalUrl: '/report/sales' }), res);

    // An HTML 404 page says nothing about the API. This shows up in the network
    // tab as something a person can fix.
    expect(written.status).toBe(404);
    expect(written.body).toEqual({
      success: false,
      error: { message: 'No route matches POST /report/sales', code: 'not_found' },
    });
  });
});
