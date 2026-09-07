import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authorize } from '../middleware/authorize';
import { requireAuth } from '../middleware/authenticate';
import { confirmCharge } from '../services/paystack.service';
import { PRODUCT_LIMITS } from '../services/inventory.service';
import {
  addPayment,
  createSale,
  getSale,
  listApprovers,
  listSales,
  paymentConfig,
  quoteSale,
  SALE_LIMITS,
  tillCategories,
  tillProducts,
  voidSale,
} from '../services/sales.service';
import { asyncHandler } from '../utils/async-handler';
import { nowIso, todayDateOnly } from '../utils/clock';
import { toDateOnlyOrNull, toEnumMember } from '../utils/coerce';
import { sendOk } from '../utils/http';
import { SALE_PAYMENT_METHODS, SALE_STATUSES, SELL_UNITS } from '../utils/schema-enums';
import { runValidation } from '../utils/validate';
import { actorOf, idParam, OPTIONAL_QUERY, pageOf, pagination, searchQuery } from './shared';

/**
 * The till: what it loads, what it prices, what it records, what it cancels.
 *
 * Mounted behind `authenticate` alone, with `authorize` naming the permission on
 * each route — the same shape as inventory, and for the same reason. Reading the
 * catalogue, ringing a sale, taking a payment and voiding one are four different
 * permissions held by three different roles, and a single `authorize` on the
 * mount would have to pick the weakest of them and would then be the only thing
 * standing between a cashier and a void.
 *
 * ## The reads are `sales:read`, not the permission for the thing they read
 *
 * `/products` reads inventory, `/approvers` reads users, `/payment-config` reads
 * the gateway configuration. All four are gated on `sales:read` anyway, because
 * the question a route answers is not "which table did that come from" but "may
 * this person run a counter". Splitting them by table would mean a role that can
 * sell but cannot see the price, and the till would fail on the second request it
 * makes at boot. Every role that holds `sales:create` also holds `sales:read`, so
 * nothing is widened by this; it just puts the four boot requests behind one
 * permission instead of four.
 *
 * ## Route order is load-bearing
 *
 * Every literal path is declared before `/:id`. Express matches in declaration
 * order, so `GET /sales/products` declared second would arrive at
 * `GET /sales/:id` with `id = "products"` and answer a UUID validation error for
 * a request that was perfectly formed. `sales.routes.test.ts` proves the literal
 * paths still win.
 *
 * ## Enum values are checked against the list the SQL casts with
 *
 * `status`, `method` and `sellUnit` are validated here against `SALE_STATUSES`,
 * `SALE_PAYMENT_METHODS` and `SELL_UNITS` — the same three arrays the
 * repositories cast their parameters with (`$n::sale_status` and the rest). That
 * is landmine 1 in BRIEF.md seen from the other end: an untyped enum reaching a
 * comparison is a Postgres parse failure and a bare 500 on every sale, and
 * `schema-enums.test.ts` keeps both ends agreeing with `init.sql`. Validating at
 * the route turns the 500 into a sentence the operator can read, and it does not
 * replace the cast — Phase 9's offline queue replays baskets that no validator
 * ever saw, so the cast stays load-bearing on its own.
 */

/**
 * The most tenders one basket may carry.
 *
 * A ceiling on the array rather than a business rule: a real split is cash and a
 * wallet, so two. Four leaves room for a wallet prompt that failed and was
 * retried as a second tender without inviting a caller to send ten thousand of
 * them, which `readPaymentInputs` would map one at a time before refusing the
 * first. The refusal is the point — an unbounded array is refused after it has
 * been read, and this refuses it before.
 */
const MAX_TENDERS_PER_SALE = 4;

/**
 * The `?category` filter on `/products`, capped at the column's own ceiling.
 *
 * Read from `PRODUCT_LIMITS` rather than spelled as a number here, and the reason
 * is that it was spelled as a number here: 120, against a `products.category`
 * that `inventory.routes.ts` refuses past 100. Nothing broke, because no stored
 * category can exceed 100 and so a 101-character filter simply matches nothing —
 * which is the worst kind of disagreement between two routes, since it is
 * invisible in every test either of them has. A till that filters the catalogue
 * and a form that writes to it are asking about one column, and now they read its
 * limit from one place.
 */
const CATEGORY_FILTER_LIMIT = PRODUCT_LIMITS.category.max;

/**
 * The basket, validated once and shared by `/quote` and `POST /`.
 *
 * Shared because the two must accept exactly the same lines or the till can
 * price a basket it cannot then ring. A quote that allows something a sale
 * refuses is worse than no quote: the operator has already told the customer the
 * total.
 *
 * There is deliberately no format check on `discount`. A JSON client sends a
 * number, an offline replay sends a string, and `utils/coerce` accepts both and
 * produces the message — `isDecimal` here would reject the number and state the
 * column's rule a second time, in a second language, with no shared test.
 */
const basketBody = [
  body(
    'lines',
    `A basket needs between ${SALE_LIMITS.lines.min} and ${SALE_LIMITS.lines.max} items`
  ).isArray({ min: SALE_LIMITS.lines.min, max: SALE_LIMITS.lines.max }),
  body('lines.*.productId', 'Every line needs a product').isUUID(),
  body(
    'lines.*.quantity',
    `Enter a quantity between ${SALE_LIMITS.quantity.min} and ${SALE_LIMITS.quantity.max}`
  ).isInt({ min: SALE_LIMITS.quantity.min, max: SALE_LIMITS.quantity.max }),
  body('lines.*.sellUnit', `Selling unit must be one of ${SELL_UNITS.join(', ')}`)
    .optional()
    .isIn(SELL_UNITS),
  body(
    'discountReason',
    `Enter a reason for the discount of at least ${SALE_LIMITS.discountReason.min} characters`
  )
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ min: SALE_LIMITS.discountReason.min, max: SALE_LIMITS.discountReason.max }),
];

/**
 * The tenders on a basket.
 *
 * `payments.*.reference` is **not** validated here, and the omission is the rule
 * rather than an oversight. On a cash tender that field is the operator's note
 * and is length-checked by the service; on a mobile money tender it is thrown
 * away and replaced by a reference this server mints, because the reference is
 * what a webhook finds the tender with and cannot be a caller's choice. A
 * length check at the route cannot tell the two apart — express-validator has no
 * "only when a sibling field holds this value" — so it would refuse a wallet
 * payment over the length of a string nobody reads. `readTender` owns the
 * conditional, and a second copy of a conditional is how two layers start
 * disagreeing about which one is true.
 */
const tendersBody = [
  body('payments', `A sale takes at most ${MAX_TENDERS_PER_SALE} payments`)
    .optional({ values: 'null' })
    .isArray({ min: 0, max: MAX_TENDERS_PER_SALE }),
  body('payments.*.method', `Payment method must be one of ${SALE_PAYMENT_METHODS.join(', ')}`).isIn(
    SALE_PAYMENT_METHODS
  ),
  body('payments.*.amount', 'Enter the amount this payment covers').exists(),
];

export const salesRoutes = Router();

// --- What the till loads at boot: literal paths, all before `/:id` -----------

salesRoutes.get(
  '/products',
  authorize('sales:read'),
  ...pagination,
  searchQuery(),
  query('category', `Enter a category of ${CATEGORY_FILTER_LIMIT} characters or fewer`)
    .optional(OPTIONAL_QUERY)
    .isString()
    .trim()
    .isLength({ max: CATEGORY_FILTER_LIMIT }),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const { limit, offset } = pageOf(req.query as Record<string, unknown>);
    const raw = req.query as Record<string, unknown>;

    const { products } = await tillProducts(
      auth.pharmacyId,
      {
        ...(raw.search === undefined || raw.search === '' ? {} : { search: String(raw.search) }),
        ...(raw.category === undefined || raw.category === ''
          ? {}
          : { category: String(raw.category) }),
        // Fixed at false and not offered as a filter. An inactive product is one
        // the write path refuses with `product_inactive`, so a grid that could
        // ask for them would show items that cannot be rung — a tile the operator
        // presses and a basket that will not complete.
        includeInactive: false,
        limit,
        offset,
      },
      todayDateOnly()
    );

    sendOk(res, { products, limit, offset });
  })
);

salesRoutes.get(
  '/categories',
  authorize('sales:read'),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendOk(res, await tillCategories(auth.pharmacyId));
  })
);

salesRoutes.get(
  '/payment-config',
  authorize('sales:read'),
  asyncHandler(async (_req, res) => {
    // Synchronous, and nothing about it is per pharmacy: the Paystack keys are
    // this deployment's, and A&B is one pharmacy. It is behind `authenticate`
    // rather than public because the public key is what Paystack's own script is
    // initialised with, and publishing it to anyone who can reach the internet
    // invites charges against A&B's account from a page nobody controls.
    sendOk(res, { paymentConfig: paymentConfig() });
  })
);

salesRoutes.get(
  '/approvers',
  authorize('sales:read'),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    // The caller is the person *naming* an approver, not the approver, so this is
    // `sales:read` and not `prescriptions:approve`. A picker that offered
    // everyone and let the write path refuse the ones without the permission
    // would be a control that works and a counter that stalls: the operator picks
    // a colleague, the sale is refused, and the customer waits while a second
    // name is tried.
    sendOk(res, await listApprovers(auth.pharmacyId));
  })
);

/**
 * Prices a basket and writes nothing.
 *
 * Write-free on purpose, and BRIEF.md's landmine 9 names this endpoint: when a
 * sale will not go through in production, being able to ask "what would this
 * basket have cost" without a lock or a write is how the difference between a
 * pricing bug and a stock bug gets found at a counter.
 *
 * The till does not call it on every keystroke. `shared/src/basket.ts` is in the
 * shared package precisely so the frontend prices a basket locally with the same
 * arithmetic the server uses; this route is the server's answer to the same
 * question, for diagnosing a disagreement and for a client that has no pricer.
 * That is also why the global rate limiter is survivable here — a pharmacy
 * behind one NAT shares a single IP bucket, and a route called on every basket
 * edit would exhaust it for everybody.
 */
salesRoutes.post(
  '/quote',
  authorize('sales:read'),
  ...basketBody,
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const input = req.body as {
      lines: unknown;
      discount?: unknown;
      discountReason?: unknown;
    };

    const quote = await quoteSale(auth.pharmacyId, input, todayDateOnly());
    // `canFulfil` is in the body rather than expressed as a status: a basket the
    // drawer cannot cover is a successful answer to "what would this cost", and a
    // 409 here would be indistinguishable from the one `POST /sales` gives, which
    // is the signal Phase 9's queue reads as "retry later".
    sendOk(res, quote);
  })
);

// --- The sale collection -----------------------------------------------------

salesRoutes.get(
  '/',
  authorize('sales:read'),
  ...pagination,
  query('status', `Status must be one of ${SALE_STATUSES.join(', ')}`)
    .optional(OPTIONAL_QUERY)
    .isIn(SALE_STATUSES),
  query('from', 'Enter the start date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  query('to', 'Enter the end date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  query('servedBy', 'That is not a valid staff id').optional(OPTIONAL_QUERY).isUUID(),
  searchQuery(),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const { limit, offset } = pageOf(req.query as Record<string, unknown>);
    const raw = req.query as Record<string, unknown>;

    const { sales } = await listSales(auth.pharmacyId, {
      // `toEnumMember` rather than a cast, even though `isIn` has just checked
      // the same list. A cast would be an assertion that the validator ran, and
      // this is a value going into a `::sale_status` comparison — the one place
      // in the codebase where being wrong is a 500 on every request rather than
      // a message.
      status:
        raw.status === undefined || raw.status === ''
          ? null
          : toEnumMember(raw.status, SALE_STATUSES, 'the status filter'),
      from: toDateOnlyOrNull(raw.from, 'the start date'),
      to: toDateOnlyOrNull(raw.to, 'the end date'),
      servedBy: raw.servedBy === undefined || raw.servedBy === '' ? null : String(raw.servedBy),
      search: raw.search === undefined || raw.search === '' ? null : String(raw.search),
      limit,
      offset,
    });

    sendOk(res, { sales, limit, offset, statuses: SALE_STATUSES });
  })
);

salesRoutes.post(
  '/',
  authorize('sales:create'),
  ...basketBody,
  ...tendersBody,
  body('patientId', 'That is not a valid patient id').optional({ values: 'null' }).isUUID(),
  body('approvedBy', 'That is not a valid approver id').optional({ values: 'null' }).isUUID(),
  body(
    'clientSaleId',
    `The till's own id for this basket must be between ${SALE_LIMITS.clientSaleId.min} and ${SALE_LIMITS.clientSaleId.max} characters`
  )
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ min: SALE_LIMITS.clientSaleId.min, max: SALE_LIMITS.clientSaleId.max }),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const actor = actorOf(req);
    const input = req.body as {
      lines: unknown;
      discount?: unknown;
      discountReason?: unknown;
      payments?: unknown;
      patientId?: unknown;
      approvedBy?: unknown;
      clientSaleId?: unknown;
    };

    // One `Date`, read once. `createSale` takes `today` and `now` separately so a
    // test can put a sale at 23:59 on the day a batch expires — but calling the
    // two helpers independently would read the clock twice, and a request that
    // straddles midnight would then be FEFO-judged against yesterday while being
    // timestamped today. Both helpers take a `Date` for exactly this.
    const moment = new Date();
    const result = await createSale(actor, input, todayDateOnly(moment), nowIso(moment));

    // 201 when the sale was recorded now, 200 when this `clientSaleId` had
    // already been recorded and the stored sale is being handed back. The
    // distinction is the answer to "did that sale go through" for a till that
    // lost the response, and `replayed` says the same thing in the body for a
    // client that reads bodies rather than statuses.
    sendOk(res, result, result.replayed ? 200 : 201);
  })
);

// --- One payment, asked of the gateway ---------------------------------------

const paymentIdParam = param('paymentId')
  .isUUID()
  .withMessage('That is not a valid payment id');

/**
 * Asks Paystack about a tender that already exists, and records the answer.
 *
 * ## This is the retry. `POST /:id/payments` is not.
 *
 * The distinction is the reason both routes are documented at length. When a
 * mobile money prompt times out — the customer's phone did not buzz, the network
 * dropped, the popup was dismissed — the operator's instinct is to take the
 * payment again. Doing that through `POST /:id/payments` mints a **fresh
 * reference** and starts a **second charge**, leaving the first tender pending
 * forever; a customer who approves both prompts is debited twice, and the second
 * debit shows up in the drawer reconciliation as money nobody can account for.
 *
 * This route asks the gateway about the tender that is already there. It cannot
 * start a charge, so it cannot double one. That is the whole difference and it is
 * invisible in the UI unless the two buttons are labelled for it.
 *
 * ## Who may press it
 *
 * `payments:verify` is not held by counter staff, so a cashier whose prompt times
 * out has to hand the sale to a pharmacist or the owner. That is the permission
 * map as written and tested in Phase 3, not a choice made here — and it is less
 * restrictive than it sounds, because the webhook settles an approved charge on
 * its own and this route is the fallback for when the webhook does not arrive.
 * The till must handle a 403 here by naming a person rather than by showing the
 * word "forbidden".
 */
salesRoutes.post(
  '/payments/:paymentId/verify',
  authorize('payments:verify'),
  paymentIdParam,
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);

    const result = await confirmCharge(
      auth.pharmacyId,
      idParam(req.params.paymentId, 'payment'),
      nowIso()
    );

    // 200 in every branch, including `unsettled`. The request succeeded: the
    // gateway was asked and answered. A 409 for "still pending" would tell Phase
    // 9's queue that this is a conflict to retry, and a 202 would say the work is
    // queued somewhere when nothing is queued — the tender is simply still
    // pending, which `unsettled` states and `detail: null` confirms by not
    // pretending anything changed shape.
    sendOk(res, result);
  })
);

// --- One sale ----------------------------------------------------------------

const saleIdParam = param('id').isUUID().withMessage('That is not a valid sale id');

salesRoutes.get(
  '/:id',
  authorize('sales:read'),
  saleIdParam,
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    // Everything a receipt and a refund conversation need, in one response: the
    // sale, its lines, the lots each line drew from, the tenders and the two
    // names. Fetching them separately would be four requests at a counter, and
    // the batches in particular are what makes "which lot did that customer get"
    // answerable without a database.
    sendOk(res, await getSale(auth.pharmacyId, idParam(req.params.id, 'sale')));
  })
);

salesRoutes.post(
  '/:id/payments',
  authorize('payments:add'),
  saleIdParam,
  body('method', `Payment method must be one of ${SALE_PAYMENT_METHODS.join(', ')}`).isIn(
    SALE_PAYMENT_METHODS
  ),
  body('amount', 'Enter the amount this payment covers').exists(),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const actor = actorOf(req);
    const input = req.body as { method: unknown; amount: unknown; reference?: unknown };

    // A new tender on an open sale, and the settlement is recomputed from every
    // tender the sale now has. 409 rather than 400 when the sale has moved on —
    // voided or already settled — because the request was well formed and the
    // sale simply is not taking money any more, which is the distinction the
    // offline queue reads to decide whether a replay is worth attempting.
    const detail = await addPayment(
      actor,
      idParam(req.params.id, 'sale'),
      input,
      nowIso()
    );
    sendOk(res, detail, 201);
  })
);

salesRoutes.post(
  '/:id/void',
  authorize('sales:void'),
  saleIdParam,
  body(
    'reason',
    `Enter why this sale is being voided — at least ${SALE_LIMITS.voidReason.min} characters, because this is the audit trail`
  )
    .isString()
    .trim()
    .isLength({ min: SALE_LIMITS.voidReason.min, max: SALE_LIMITS.voidReason.max }),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const actor = actorOf(req);
    const input = req.body as { reason: unknown };

    // The voided sale comes back rather than an acknowledgement, because the one
    // thing the owner has to see is that the stock went back to the batches it
    // came from and the tenders were reversed. A `{ voided: true }` asks them to
    // reload to find out whether the drawer is now correct.
    const detail = await voidSale(actor, idParam(req.params.id, 'sale'), input, nowIso());
    sendOk(res, detail);
  })
);
