import { Router } from 'express';
import { query } from 'express-validator';
import { requireAuth } from '../middleware/authenticate';
import { REPORT_LIMITS, salesReport } from '../services/reports.service';
import { asyncHandler } from '../utils/async-handler';
import { nowIso, todayDateOnly } from '../utils/clock';
import { toDateOnlyOrNull } from '../utils/coerce';
import { sendOk } from '../utils/http';
import { runValidation } from '../utils/validate';
import { OPTIONAL_QUERY, pageOf, pagination } from './shared';

/**
 * Reports: the figures an owner reads after the shutters go down.
 *
 * One route and one permission, which is why the mount authorises once rather than
 * per route — the shape `routes/index.ts` describes for a router a single
 * permission covers. `reports:read` is held by the owner and the pharmacist and
 * not by counter staff, so there is no weaker half of this router to protect: a
 * report is the whole business in one response, and there is no version of it that
 * is safe for somebody who should not see the margin.
 *
 * Read-only, and mounted with no write verb at all. A report that could be
 * corrected would be a second set of books.
 *
 * ## One bundle rather than five endpoints
 *
 * The summary, the daily breakdown, the profitability, the staff performance and
 * the VAT return arrive together, because they are one question — "how did we do" —
 * asked over one window, and five endpoints would be five chances for the caller to
 * ask four of them about a different range than the fifth. A page showing takings
 * from Tuesday and a VAT return from Monday is not obviously wrong; it is just
 * wrong.
 *
 * It also means one round trip over a connection that Phase 9 will sometimes be
 * queuing, and one response for the offline cache to store and date-stamp.
 *
 * ## The window is validated twice, on purpose
 *
 * `isDate` here turns a malformed range into a sentence at the counter. The service
 * checks again, because it is the half that owns the *relationship* between the two
 * ends — which one is earlier, and how far apart they may be — and express-validator
 * has no "only when a sibling field holds this value". A length check duplicated
 * across two layers is the kind of copy that drifts; a rule that only one layer can
 * express is not.
 */
export const reportsRoutes = Router();

reportsRoutes.get(
  '/sales',
  ...pagination,
  query('from', 'Enter the start date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  query('to', 'Enter the end date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const { limit, offset } = pageOf(req.query as Record<string, unknown>);
    const raw = req.query as Record<string, unknown>;

    // One `Date`, read once and passed down as both the window's default and the
    // bundle's timestamp. Reading the clock twice would let a request that arrives
    // a millisecond before midnight produce a report generated on the day after the
    // one it defaults to — and the pair of figures would then disagree on a page
    // whose whole job is to be believed.
    const now = new Date();

    sendOk(res, {
      report: await salesReport(
        auth.pharmacyId,
        {
          from: toDateOnlyOrNull(raw.from, 'the start date'),
          to: toDateOnlyOrNull(raw.to, 'the end date'),
          limit,
          offset,
        },
        todayDateOnly(now),
        nowIso(now)
      ),
      // Echoed beside the report rather than buried in it, so a caller paging the
      // product list can hold the window and the page size in one place. Both are
      // the values the service actually used, defaults filled in, not the values
      // the caller happened to send.
      limit,
      offset,
      maxRangeDays: REPORT_LIMITS.rangeDays.max,
    });
  })
);
