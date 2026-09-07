import type { NextFunction, Request, Response } from 'express';
import { can, type Permission } from '../utils/permissions';
import { HttpError } from '../utils/http';

/**
 * Route-level authorisation: `router.use(authenticate, authorize('staff:manage'))`.
 *
 * Runs after `authenticate`, which is the only thing that sets `req.auth`; a
 * missing context here is therefore a mounting mistake, and is reported as
 * 401 rather than silently allowed.
 */
export function authorize(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (auth === undefined) {
      next(new HttpError(401, 'Authentication required', { code: 'not_authenticated' }));
      return;
    }

    const missing = required.filter((permission) => !can(auth.role, permission));
    if (missing.length > 0) {
      next(
        new HttpError(403, 'Your role does not permit this action', {
          code: 'forbidden',
          details: { missing },
        })
      );
      return;
    }

    next();
  };
}
