import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authorize } from '../middleware/authorize';
import { requireAuth } from '../middleware/authenticate';
import { importProductsCsv, importTemplate } from '../services/inventory-import.service';
import {
  adjustBatch,
  createProduct,
  DERIVED_PRODUCT_FIELDS,
  getProduct,
  listMovements,
  listProducts,
  PRODUCT_LIMITS,
  recallBatch,
  receiveStock,
  updateProduct,
  writeOffBatch,
} from '../services/inventory.service';
import { listStockAlerts, scanStockAlerts, STOCK_ALERT_TYPES } from '../services/alerts.service';
import { asyncHandler } from '../utils/async-handler';
import { todayDateOnly } from '../utils/clock';
import { toBoolean } from '../utils/coerce';
import { HttpError, sendOk } from '../utils/http';
import { SELL_UNITS, VAT_TREATMENTS } from '../utils/schema-enums';
import { runValidation } from '../utils/validate';
import {
  actorOf,
  booleanQuery,
  idParam,
  MAX_LIST_LIMIT,
  OPTIONAL_QUERY,
  pageOf,
  pagination,
  searchQuery,
} from './shared';

/**
 * Inventory: products, batches, the movement ledger, recall and alerts.
 *
 * Mounted behind `authenticate` alone, with `authorize` naming the permission on
 * each route. The alternative — one `authorize` on the mount — cannot work here
 * because reading stock and correcting it are different permissions held by
 * different roles, and a till operator needs the first without the second.
 *
 * **Route order below is load-bearing.** `/alerts` and `/import` are registered
 * before `/:id`, because Express matches in the order routes are declared and
 * `GET /inventory/alerts` would otherwise arrive at `GET /inventory/:id` with
 * `id = "alerts"`. `inventory.routes.test.ts` proves the literal paths still win.
 */

// `pagination`, `pageOf`, `actorOf`, `idParam` and the two list limits are in
// `routes/shared.ts`, where `sales.routes.ts` reads the same ones rather than a
// second copy of them.

/**
 * The product fields, validated once and shared by create and update.
 *
 * Every chain carries its message as the **default** — the second argument to
 * `body()` — rather than as a `.withMessage()` on the last validator. The two
 * differ exactly when a field is missing or of the wrong type: `.withMessage()`
 * belongs to the validator it follows, so
 * `.isString().trim().isLength(...).withMessage('Enter a product code')` reports
 * that sentence only when the value is a string of the wrong length, and reports
 * express-validator's own "Invalid value" when the field is absent or is a
 * number. A blank required field is the most common mistake a form makes, so it
 * is the one case that must not produce the generic message.
 */
const productBody = [
  body('name', 'Enter the product name as it appears on the box')
    .optional()
    .isString()
    .trim()
    .isLength({ min: PRODUCT_LIMITS.name.min, max: PRODUCT_LIMITS.name.max }),
  body('code', 'Enter a product code')
    .optional()
    .isString()
    .trim()
    .isLength({ min: PRODUCT_LIMITS.code.min, max: PRODUCT_LIMITS.code.max }),
  body('genericName', `Enter a generic name of ${PRODUCT_LIMITS.genericName.max} characters or fewer`)
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ max: PRODUCT_LIMITS.genericName.max }),
  body('category', `Enter a category of ${PRODUCT_LIMITS.category.max} characters or fewer`)
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ max: PRODUCT_LIMITS.category.max }),
  body('manufacturer', `Enter a manufacturer of ${PRODUCT_LIMITS.manufacturer.max} characters or fewer`)
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ max: PRODUCT_LIMITS.manufacturer.max }),
  body('shelfLocation', `Enter a shelf location of ${PRODUCT_LIMITS.shelfLocation.max} characters or fewer`)
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ max: PRODUCT_LIMITS.shelfLocation.max }),
  body('barcode', `Enter a barcode of ${PRODUCT_LIMITS.barcode.max} characters or fewer`)
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ max: PRODUCT_LIMITS.barcode.max }),
  body('packSize', 'Pack size must be a whole number of 1 or more')
    .optional()
    .isInt({ min: PRODUCT_LIMITS.packSize.min, max: PRODUCT_LIMITS.packSize.max }),
  body('defaultSellUnit', `Selling unit must be one of ${SELL_UNITS.join(', ')}`)
    .optional()
    .isIn(SELL_UNITS),
  body('requiresPrescription', 'Enter requiresPrescription as true or false')
    .optional()
    .isBoolean(),
  body('reorderLevel', 'Reorder level must be a whole number of 0 or more')
    .optional()
    .isInt({ min: PRODUCT_LIMITS.reorderLevel.min, max: PRODUCT_LIMITS.reorderLevel.max }),
  // No format check on the money fields here. A JSON client sends a number and a
  // CSV cell is a string, and `utils/coerce.ts` accepts both and produces the
  // message; `isDecimal` would reject the number and duplicate the rule.
  body('vatTreatment', `VAT treatment must be one of ${VAT_TREATMENTS.join(', ')}`)
    .optional()
    .isIn(VAT_TREATMENTS),
  body('isActive', 'Enter isActive as true or false').optional().isBoolean(),
];

export const inventoryRoutes = Router();

// --- Alerts and import: literal paths, declared before every `/:id` ----------

inventoryRoutes.get(
  '/alerts',
  authorize('notifications:read'),
  ...pagination,
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const { limit, offset } = pageOf(req.query as Record<string, unknown>);

    const alerts = await listStockAlerts(auth.pharmacyId, { limit, offset });
    sendOk(res, {
      alerts,
      // Every alert this panel shows was raised as `not_sent`, and the reason is
      // on the row. Surfacing it once here means the UI does not have to infer
      // from an empty `sentAt` that nothing was delivered.
      delivery: 'Shown in the app only — no SMS provider is configured.',
      types: STOCK_ALERT_TYPES,
    });
  })
);

inventoryRoutes.post(
  '/alerts/scan',
  authorize('inventory:alerts:scan'),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    // Today is computed here rather than inside the service so the scan stays
    // testable against a date in the past. Ghana is UTC+0 with no daylight
    // saving, so the UTC date is the date on the wall in Accra — see utils/clock.
    const summary = await scanStockAlerts(auth.pharmacyId, todayDateOnly());
    sendOk(res, { scan: summary });
  })
);

inventoryRoutes.get(
  '/import/template',
  authorize('inventory:import'),
  asyncHandler(async (_req, res) => {
    // The header line of a blank template, so the file a pharmacist fills in has
    // exactly the columns the importer accepts and no others.
    res.type('text/csv').send(importTemplate());
  })
);

inventoryRoutes.post(
  '/import',
  authorize('inventory:import'),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    // Two accepted shapes. A browser uploading a file posts it as `text/csv`,
    // which `express.text()` in app.ts puts in `req.body` as a string; an API
    // client that would otherwise need multipart posts `{ "csv": "..." }`.
    // Refusing either would push the frontend into a dependency it does not need.
    let source: string;
    if (typeof req.body === 'string') {
      source = req.body;
    } else if (
      typeof req.body === 'object' &&
      req.body !== null &&
      typeof (req.body as { csv?: unknown }).csv === 'string'
    ) {
      source = (req.body as { csv: string }).csv;
    } else {
      throw new HttpError(
        400,
        'Send the file as text/csv, or as JSON with the file in a "csv" field',
        { code: 'csv_body_missing' }
      );
    }

    const result = await importProductsCsv(actor, source);

    // 200 when something landed, even if other rows did not: the work was done
    // and the report says which rows need fixing. 422 when the file was
    // understood but nothing could be imported — a 400 would say "we could not
    // read this", which is not what happened, and a 200 would say it worked.
    if (result.imported.length === 0) {
      throw new HttpError(422, 'No rows were imported', {
        code: 'csv_nothing_imported',
        details: { rowsInFile: result.rowsInFile, failed: result.failed },
      });
    }

    sendOk(res, result);
  })
);

// --- The product collection --------------------------------------------------

/**
 * The phrase `?includeInactive` is refused with, in one place.
 *
 * The validator and the reader below both take it, so the two cannot start wording
 * the same field differently. `routes/shared.ts` records why the validator runs
 * `toBoolean` instead of `.isBoolean()`, which is what this chain used to do: the
 * library validator accepts `true`, `false`, `1` and `0` and refuses `on`, which
 * is what an HTML checkbox serialises to when nobody set a `value` on it.
 */
const INCLUDE_INACTIVE_LABEL = 'including inactive products';

inventoryRoutes.get(
  '/',
  authorize('inventory:read'),
  ...pagination,
  searchQuery(),
  query('category', `Enter a category of ${PRODUCT_LIMITS.category.max} characters or fewer`)
    .optional(OPTIONAL_QUERY)
    .isString()
    .trim()
    .isLength({ max: PRODUCT_LIMITS.category.max }),
  booleanQuery('includeInactive', INCLUDE_INACTIVE_LABEL),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const { limit, offset } = pageOf(req.query as Record<string, unknown>);
    const raw = req.query as Record<string, unknown>;

    const products = await listProducts(auth.pharmacyId, {
      ...(raw.search === undefined || raw.search === '' ? {} : { search: String(raw.search) }),
      ...(raw.category === undefined || raw.category === ''
        ? {}
        : { category: String(raw.category) }),
      // Absent is a settled `false` here, which is `toBoolean`'s own answer for
      // an empty cell and the one this filter wants: a product list with no
      // question asked about inactive stock is a list of the active ones.
      // `notifications.routes.ts` reads its yes/no filter the other way round,
      // because there an absent key has to stay absent rather than claim that
      // somebody asked for the read ones too.
      includeInactive: toBoolean(raw.includeInactive, INCLUDE_INACTIVE_LABEL),
      limit,
      offset,
    });

    sendOk(res, { products, limit, offset });
  })
);

inventoryRoutes.post(
  '/',
  authorize('inventory:product:write'),
  ...productBody,
  body('name', 'Enter the product name as it appears on the box').notEmpty(),
  body('code', 'Enter a product code').notEmpty(),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const actor = actorOf(req);

    const { product, discarded } = await createProduct(
      actor,
      req.body as Record<string, unknown>
    );
    // `discardedFields` is always in the response, empty or not. A caller that
    // sent a derived column needs to hear that it was thrown away: a bare 201
    // reads as "saved", and the value they sent would appear to have taken
    // effect until the next batch change recomputed it away.
    sendOk(res, { product, discardedFields: discarded, derivedFields: DERIVED_PRODUCT_FIELDS }, 201);
  })
);

// --- One product -------------------------------------------------------------

const productId = param('id').isUUID().withMessage('That is not a valid product id');
const batchId = param('batchId').isUUID().withMessage('That is not a valid batch id');

inventoryRoutes.get(
  '/:id',
  authorize('inventory:read'),
  productId,
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const detail = await getProduct(
      auth.pharmacyId,
      idParam(req.params.id, 'product'),
      todayDateOnly()
    );
    sendOk(res, detail);
  })
);

inventoryRoutes.patch(
  '/:id',
  authorize('inventory:product:write'),
  productId,
  ...productBody,
  asyncHandler(async (req, res) => {
    runValidation(req);
    const actor = actorOf(req);
    const { product, discarded } = await updateProduct(
      actor,
      idParam(req.params.id, 'product'),
      req.body as Record<string, unknown>
    );
    sendOk(res, { product, discardedFields: discarded, derivedFields: DERIVED_PRODUCT_FIELDS });
  })
);

inventoryRoutes.get(
  '/:id/movements',
  authorize('inventory:read'),
  productId,
  query('limit')
    .optional()
    .isInt({ min: 1, max: MAX_LIST_LIMIT })
    .withMessage(`limit must be between 1 and ${MAX_LIST_LIMIT}`),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const { limit } = pageOf(req.query as Record<string, unknown>);
    const movements = await listMovements(
      auth.pharmacyId,
      idParam(req.params.id, 'product'),
      limit
    );
    sendOk(res, { movements });
  })
);

inventoryRoutes.get(
  '/:id/batches',
  authorize('inventory:read'),
  productId,
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    // `getProduct` already returns the batches in FEFO order plus the figures the
    // batch panel shows, so the panel and the product card cannot disagree.
    const detail = await getProduct(
      auth.pharmacyId,
      idParam(req.params.id, 'product'),
      todayDateOnly()
    );
    sendOk(res, {
      batches: detail.batches,
      sellable: detail.sellable,
      leading: detail.leading,
      leadingDaysToExpiry: detail.leadingDaysToExpiry,
    });
  })
);

inventoryRoutes.post(
  '/:id/batches',
  authorize('inventory:receive'),
  productId,
  body('lotNumber', 'Enter the lot number printed on the delivery')
    .isString()
    .trim()
    .isLength({ min: PRODUCT_LIMITS.lotNumber.min, max: PRODUCT_LIMITS.lotNumber.max }),
  body('quantity', 'Enter how many units arrived').isInt({
    min: PRODUCT_LIMITS.quantity.min,
    max: PRODUCT_LIMITS.quantity.max,
  }),
  body('expiryDate', 'Enter the expiry date as YYYY-MM-DD, or leave it empty for undated stock')
    .optional({ values: 'null' })
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  body('receivedAt', 'Enter the received date and time').optional().isISO8601(),
  body('reason', `Enter a reason of at least ${PRODUCT_LIMITS.reason.min} characters`)
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ min: PRODUCT_LIMITS.reason.min, max: PRODUCT_LIMITS.reason.max }),
  body('note', `Enter a note of ${PRODUCT_LIMITS.note.max} characters or fewer`)
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ min: 1, max: PRODUCT_LIMITS.note.max }),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const actor = actorOf(req);
    const input = req.body as {
      lotNumber: string;
      quantity: number | string;
      costPrice?: string | number;
      expiryDate?: string | null;
      receivedAt?: string;
      reason?: string | null;
      note?: string | null;
    };

    const result = await receiveStock(actor, idParam(req.params.id, 'product'), {
      lotNumber: input.lotNumber,
      // Passed through as they arrived. The service coerces with `utils/coerce`,
      // which accepts a JSON number and a form string and produces the decimal
      // string Postgres stores — converting here instead would turn a missing
      // cost price into the literal text "undefined" and hand that to the driver.
      quantity: input.quantity,
      costPrice: input.costPrice ?? 0,
      expiryDate: input.expiryDate ?? null,
      receivedAt: input.receivedAt,
      reason: input.reason ?? null,
      note: input.note ?? null,
    });

    sendOk(res, result, result.merged ? 200 : 201);
  })
);

inventoryRoutes.get(
  '/:id/batches/:batchId/recall',
  authorize('inventory:recall:read'),
  productId,
  batchId,
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const recall = await recallBatch(
      auth.pharmacyId,
      idParam(req.params.id, 'product'),
      idParam(req.params.batchId, 'batch')
    );
    // Voided sales are in `sales` with their status, not filtered out: a recall
    // is a safety operation and quietly dropping records is the wrong default.
    sendOk(res, recall);
  })
);

/**
 * A reason and a note, mandatory on both corrections.
 *
 * Enforced here rather than in the schema because the schema cannot say why: an
 * adjustment with no reason recorded is indistinguishable from stock that walked
 * out of the door. Neither is optional on a correction, and both are optional on
 * a receive — see the note on that route.
 */
const correctionBody = [
  body('reason', 'Enter why the stock is changing — this is the audit trail')
    .isString()
    .trim()
    .isLength({ min: PRODUCT_LIMITS.reason.min, max: PRODUCT_LIMITS.reason.max }),
  body('note', 'Enter a note describing what was counted or what happened')
    .isString()
    .trim()
    .isLength({ min: 1, max: PRODUCT_LIMITS.note.max }),
];

inventoryRoutes.post(
  '/:id/batches/:batchId/adjust',
  authorize('inventory:adjust'),
  productId,
  batchId,
  ...correctionBody,
  body('quantity', 'Enter the quantity the batch should hold after the correction').isInt({
    min: 0,
    max: PRODUCT_LIMITS.quantity.max,
  }),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const actor = actorOf(req);
    const input = req.body as {
      quantity: number | string;
      reason: string;
      note: string;
    };

    const result = await adjustBatch(
      actor,
      idParam(req.params.id, 'product'),
      idParam(req.params.batchId, 'batch'),
      {
        // The absolute counted quantity, not a delta. A counted shelf is an
        // absolute fact, and deriving the delta here means the ledger and the
        // batch cannot disagree about what changed.
        quantity: input.quantity,
        reason: input.reason,
        note: input.note,
      }
    );
    sendOk(res, result);
  })
);

inventoryRoutes.post(
  '/:id/batches/:batchId/write-off',
  authorize('inventory:write_off'),
  productId,
  batchId,
  ...correctionBody,
  body('quantity', 'Enter how many units to write off')
    .optional()
    .isInt({ min: 1, max: PRODUCT_LIMITS.quantity.max }),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const actor = actorOf(req);
    const input = req.body as {
      quantity?: number | string;
      reason: string;
      note: string;
    };

    const result = await writeOffBatch(
      actor,
      idParam(req.params.id, 'product'),
      idParam(req.params.batchId, 'batch'),
      {
        // Omitted means the whole batch: a shelf of expired stock goes out at
        // once, and making the pharmacist type the number back is a chance to
        // type a different one.
        quantity: input.quantity,
        reason: input.reason,
        note: input.note,
      }
    );
    sendOk(res, result);
  })
);
