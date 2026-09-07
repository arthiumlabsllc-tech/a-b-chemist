import type { AuthContext } from '../utils/jwt';

/**
 * `req.auth` is set by the authenticate middleware and read by authorize and
 * every route. Declaring it here keeps both sides of that contract typed: a
 * route that reads `req.auth` without mounting authenticate is a compile
 * error only if it forgets the optional check, so routes use `req.auth!`
 * after authenticate or take it as a parameter.
 *
 * `req.rawBody` is set by the `verify` hook on the JSON body parser in `app.ts`,
 * for one path only. See the note on that hook for why the bytes have to be kept
 * aside rather than re-serialised from the parsed object.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /**
       * The exact bytes of the request body, before the JSON parser touched
       * them. Present only where a signature has to be checked over them.
       */
      rawBody?: Buffer;
    }
  }
}

export {};
