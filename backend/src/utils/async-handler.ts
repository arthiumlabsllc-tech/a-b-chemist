import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

/**
 * Wraps an async route handler so a rejected promise reaches the error handler.
 *
 * This is not a style preference. Express 4 does not await handlers: a rejection
 * bypasses every error middleware and the request hangs until the client times
 * out, with the failure visible only as an unhandled-rejection warning. On a
 * till that means the cashier stares at a spinner that never resolves. Express 5
 * fixes this natively; this package is on Express 4.
 */
export function asyncHandler(handler: AsyncRouteHandler): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
