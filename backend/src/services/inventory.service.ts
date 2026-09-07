import { poolSql, withTransaction } from '../database/pool';
import {
  createProduct as insertProduct,
  findBatch,
  findBatchByLot,
  findProductById,
  insertBatch,
  insertMovement,
  listBatchesForProduct,
  listMovements as queryMovements,
  listProducts as queryProducts,
  lockProduct,
  mergeIntoBatch,
  recallTrace,
  setBatchQuantity,
  updateProduct as applyProductPatch,
  type BatchRow,
  type MovementRow,
  type NewProduct,
  type ProductFilters,
  type ProductPatch,
  type ProductRow,
  type RecallSaleRow,
} from '../repositories/inventory.repository';
import { nowIso } from '../utils/clock';
import {
  COST_PRICE,
  toBoolean,
  toDateOnlyOrNull,
  toEnumMember,
  toInteger,
  toMoneyString,
  toText,
  toTextOrNull,
  UNIT_PRICE,
} from '../utils/coerce';
import { daysUntilExpiry, leadingBatch, sellableUnits } from '../utils/fefo';
import { HttpError, notFound } from '../utils/http';
import { SELL_UNITS, VAT_TREATMENTS, type MovementType } from '../utils/schema-enums';

/**
 * The inventory write path.
 *
 * Three rules run through everything here.
 *
 * **Every stock movement writes a ledger row in the same transaction as the
 * change it describes.** A batch that moves without a `stock_movements` row is
 * stock that changed with no record of who changed it or why, which is the one
 * thing a pharmacy cannot reconstruct afterwards. The row and the change commit
 * together or not at all.
 *
 * **The product row is locked before any batch of it is read.** Receive, adjust
 * and write-off are all read-modify-write on `quantity`. Two of them running at
 * once produce a `quantity_after` in the ledger that no batch ever held, and the
 * error is invisible until somebody counts the shelf.
 *
 * **The four derived product columns are never written.** They are recomputed
 * from the batches by a trigger, so after every batch write the product is read
 * back rather than returned from the lock — the locked copy predates the change.
 */

/** Who is performing the write, taken from the verified token. */
export interface Actor {
  userId: string;
  pharmacyId: string;
}

/**
 * Every field limit, in one table.
 *
 * The JSON routes validate shape with express-validator and the CSV import and
 * the services coerce with `utils/coerce.ts`, so each limit is checked in two
 * places by design: one says "this field is the wrong kind of thing" before the
 * handler runs, the other says "this value cannot be stored" for callers that
 * never went through a validator. What must not happen is the two disagreeing,
 * so both read their numbers from here.
 */
export const PRODUCT_LIMITS = {
  name: { min: 1, max: 200 },
  code: { min: 1, max: 64 },
  genericName: { min: 0, max: 200 },
  category: { min: 0, max: 100 },
  manufacturer: { min: 0, max: 200 },
  shelfLocation: { min: 0, max: 100 },
  barcode: { min: 0, max: 64 },
  packSize: { min: 1, max: 100_000 },
  reorderLevel: { min: 0, max: 1_000_000 },
  quantity: { min: 1, max: 1_000_000 },
  lotNumber: { min: 1, max: 100 },
  /** A reason shorter than this is a shrug, and a shrug is not an audit trail. */
  reason: { min: 3, max: 200 },
  note: { min: 0, max: 500 },
} as const;

/**
 * The four product columns a batch trigger owns.
 *
 * Exported because the acceptance test for this phase is exactly "these cannot
 * be written through the API", and a test that spells the list out twice can
 * pass while the code and the test disagree about what the list is.
 */
export const DERIVED_PRODUCT_FIELDS = [
  'quantity',
  'batchNumber',
  'expiryDate',
  'costPrice',
] as const;

/**
 * Every spelling of a derived field that counts as an attempt to write it.
 *
 * Both conventions are recognised here and nowhere else. The field builders
 * below are camelCase-only, because the API speaks camelCase and the CSV import
 * translates its own column names before it gets here. This map is deliberately
 * more liberal: its whole job is to notice that somebody tried, and a client
 * that sends `cost_price` instead of `costPrice` was still trying.
 */
const DERIVED_SPELLINGS: ReadonlyMap<string, string> = new Map([
  ['quantity', 'quantity'],
  ['batchnumber', 'batchNumber'],
  ['batch_number', 'batchNumber'],
  ['expirydate', 'expiryDate'],
  ['expiry_date', 'expiryDate'],
  ['costprice', 'costPrice'],
  ['cost_price', 'costPrice'],
]);

export interface DerivedSplit {
  /** The body with every derived field removed. */
  editable: Record<string, unknown>;
  /** The canonical names of the derived fields that were present, in a fixed order. */
  discarded: string[];
}

/**
 * Separates what a caller may set from what the batches decide.
 *
 * This is the second of three layers keeping the derived columns unwritable.
 * `ProductPatch` does not contain them, so a builder cannot pass one through by
 * accident; the handlers below name every field explicitly rather than
 * spreading the body, so an unlisted key cannot reach the statement; and this
 * function reports what was thrown away, because a discard nobody is told about
 * looks identical to a save that worked.
 */
export function splitDerivedFields(body: Record<string, unknown>): DerivedSplit {
  const editable: Record<string, unknown> = {};
  const found = new Set<string>();

  for (const [key, value] of Object.entries(body)) {
    const derived = DERIVED_SPELLINGS.get(key.toLowerCase());
    if (derived === undefined) {
      editable[key] = value;
      continue;
    }
    // `undefined` is not an attempt: a JSON body cannot carry it, and an absent
    // value reported as discarded would teach the reader to ignore the list.
    if (value !== undefined) found.add(derived);
  }

  return {
    editable,
    discarded: DERIVED_PRODUCT_FIELDS.filter((field) => found.has(field)),
  };
}

export interface ProductDetail {
  product: ProductRow;
  batches: BatchRow[];
  /** Base units that can actually be sold today, expired stock excluded. */
  sellable: number;
  /** The lot at the front of the shelf, expired or not. Null when there is no stock. */
  leading: BatchRow | null;
  /** Days until `leading` expires. Negative means already expired; null means undated. */
  leadingDaysToExpiry: number | null;
}

export interface ProductWriteResult {
  product: ProductRow;
  /** What the caller sent that was thrown away, and why it was. */
  discarded: string[];
}

export interface ReceiveInput {
  lotNumber: string;
  /** Base units arriving. Positive. A number from JSON or a string from a form. */
  quantity: number | string;
  /** A number from JSON, a decimal string from a form or a CSV cell. */
  costPrice: string | number;
  expiryDate: string | null;
  /** ISO-8601. Defaults to now; a future value is refused. */
  receivedAt?: string;
  reason?: string | null;
  note?: string | null;
}

export interface StockWriteResult {
  product: ProductRow;
  batch: BatchRow;
  movementType: MovementType;
  /** Signed, as the ledger records it. */
  quantityChange: number;
  quantityAfter: number;
  /** True when a receive landed on an existing lot rather than creating one. */
  merged: boolean;
}

export interface AdjustInput {
  /** The absolute quantity the batch should hold afterwards. */
  quantity: number | string;
  reason: string;
  note: string | null;
}

export interface WriteOffInput {
  /** Units to remove. Defaults to the whole batch. */
  quantity?: number | string;
  reason: string;
  note: string | null;
}

export interface RecallContact {
  name: string;
  phone: string | null;
  /** How many of the recalled sales went to this person. */
  sales: number;
}

export interface RecallResult {
  product: ProductRow;
  batch: BatchRow;
  sales: RecallSaleRow[];
  contacts: RecallContact[];
  /**
   * Sales with no patient attached. A walk-in at the counter is untraceable by
   * design, and saying how many there were is more useful than a contact list
   * that quietly looks complete.
   */
  untraceableSales: number;
}

/**
 * The `receivedAt` a receive is stamped with.
 *
 * Defaults to the server clock, because that is the honest answer to "when did
 * this arrive" for a form that has no field for it. An explicit value is
 * accepted — a delivery logged after the fact needs one — and a future value is
 * refused: `received_at` is the FEFO tie-break, so a receive dated next week
 * would sort behind every lot that arrived before it and be sold last, which is
 * the opposite of what the tie-break is for.
 *
 * Exported because the CSV import applies the same rule to its `received_at`
 * column. Two copies of this check would be two chances to get the FEFO
 * tie-break wrong in one of them.
 */
export function resolveReceivedAt(supplied: string | undefined): string {
  if (supplied === undefined || supplied.trim() === '') return nowIso();
  const text = supplied.trim();
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new HttpError(400, 'Enter the received date in a form such as 2026-03-15T09:00:00Z', {
      code: 'validation_failed',
    });
  }
  if (parsed > Date.now()) {
    throw new HttpError(400, 'Stock cannot be received in the future', {
      code: 'received_at_in_future',
    });
  }
  return new Date(parsed).toISOString();
}

/** Builds a product row from a request body that has already had the derived fields removed. */
function toNewProduct(actor: Actor, editable: Record<string, unknown>): NewProduct {
  return {
    pharmacyId: actor.pharmacyId,
    name: toText(editable.name, 'a product name', PRODUCT_LIMITS.name.max),
    code: toText(editable.code, 'a product code', PRODUCT_LIMITS.code.max),
    genericName: toTextOrNull(editable.genericName, 'the generic name', PRODUCT_LIMITS.genericName.max),
    category: toTextOrNull(editable.category, 'the category', PRODUCT_LIMITS.category.max),
    manufacturer: toTextOrNull(
      editable.manufacturer,
      'the manufacturer',
      PRODUCT_LIMITS.manufacturer.max
    ),
    packSize: toInteger(editable.packSize ?? 1, 'the pack size', PRODUCT_LIMITS.packSize),
    defaultSellUnit: toEnumMember(
      editable.defaultSellUnit ?? 'single',
      SELL_UNITS,
      'the selling unit'
    ),
    shelfLocation: toTextOrNull(
      editable.shelfLocation,
      'the shelf location',
      PRODUCT_LIMITS.shelfLocation.max
    ),
    barcode: toTextOrNull(editable.barcode, 'the barcode', PRODUCT_LIMITS.barcode.max),
    requiresPrescription: toBoolean(
      editable.requiresPrescription,
      'whether it needs a prescription'
    ),
    reorderLevel: toInteger(
      editable.reorderLevel ?? 0,
      'the reorder level',
      PRODUCT_LIMITS.reorderLevel
    ),
    unitPrice: toMoneyString(editable.unitPrice ?? 0, UNIT_PRICE),
    vatTreatment: toEnumMember(
      editable.vatTreatment ?? 'exempt',
      VAT_TREATMENTS,
      'the VAT treatment'
    ),
    isActive:
      editable.isActive === undefined ? true : toBoolean(editable.isActive, 'whether it is active'),
  };
}

/**
 * Builds a patch naming every editable field explicitly.
 *
 * No spread of the body anywhere near an UPDATE. A field that is not named here
 * cannot be written, which is what makes the derived columns safe even if
 * `splitDerivedFields` were removed — and it is why `ProductPatch` omitting them
 * is a real guarantee rather than a comment.
 */
function toProductPatch(editable: Record<string, unknown>): ProductPatch {
  const patch: ProductPatch = {};
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(editable, key);

  if (has('name')) patch.name = toText(editable.name, 'a product name', PRODUCT_LIMITS.name.max);
  if (has('genericName')) {
    patch.genericName = toTextOrNull(
      editable.genericName,
      'the generic name',
      PRODUCT_LIMITS.genericName.max
    );
  }
  if (has('category')) {
    patch.category = toTextOrNull(editable.category, 'the category', PRODUCT_LIMITS.category.max);
  }
  if (has('manufacturer')) {
    patch.manufacturer = toTextOrNull(
      editable.manufacturer,
      'the manufacturer',
      PRODUCT_LIMITS.manufacturer.max
    );
  }
  if (has('packSize')) {
    patch.packSize = toInteger(editable.packSize, 'the pack size', PRODUCT_LIMITS.packSize);
  }
  if (has('defaultSellUnit')) {
    patch.defaultSellUnit = toEnumMember(editable.defaultSellUnit, SELL_UNITS, 'the selling unit');
  }
  if (has('shelfLocation')) {
    patch.shelfLocation = toTextOrNull(
      editable.shelfLocation,
      'the shelf location',
      PRODUCT_LIMITS.shelfLocation.max
    );
  }
  if (has('barcode')) {
    patch.barcode = toTextOrNull(editable.barcode, 'the barcode', PRODUCT_LIMITS.barcode.max);
  }
  if (has('requiresPrescription')) {
    patch.requiresPrescription = toBoolean(
      editable.requiresPrescription,
      'whether it needs a prescription'
    );
  }
  if (has('reorderLevel')) {
    patch.reorderLevel = toInteger(
      editable.reorderLevel,
      'the reorder level',
      PRODUCT_LIMITS.reorderLevel
    );
  }
  if (has('unitPrice')) patch.unitPrice = toMoneyString(editable.unitPrice, UNIT_PRICE);
  if (has('vatTreatment')) {
    patch.vatTreatment = toEnumMember(editable.vatTreatment, VAT_TREATMENTS, 'the VAT treatment');
  }
  if (has('isActive')) patch.isActive = toBoolean(editable.isActive, 'whether it is active');

  return patch;
}

export async function listProducts(
  pharmacyId: string,
  filters: ProductFilters
): Promise<ProductRow[]> {
  return queryProducts(poolSql, pharmacyId, filters);
}

/** A product with its batches and the two figures the product card shows. */
export async function getProduct(
  pharmacyId: string,
  productId: string,
  today: string
): Promise<ProductDetail> {
  const product = await findProductById(poolSql, pharmacyId, productId);
  if (product === null) throw notFound('product');

  const batches = await listBatchesForProduct(poolSql, pharmacyId, productId);
  const leading = leadingBatch(batches);
  return {
    product,
    batches,
    sellable: sellableUnits(batches, today),
    leading,
    leadingDaysToExpiry:
      leading === null ? null : daysUntilExpiry(leading.expiryDate, today),
  };
}

export async function createProduct(
  actor: Actor,
  body: Record<string, unknown>
): Promise<ProductWriteResult> {
  const { editable, discarded } = splitDerivedFields(body);
  const product = await insertProduct(poolSql, toNewProduct(actor, editable));
  return { product, discarded };
}

export async function updateProduct(
  actor: Actor,
  productId: string,
  body: Record<string, unknown>
): Promise<ProductWriteResult> {
  const { editable, discarded } = splitDerivedFields(body);
  const product = await applyProductPatch(
    poolSql,
    actor.pharmacyId,
    productId,
    toProductPatch(editable)
  );
  if (product === null) throw notFound('product');
  return { product, discarded };
}

/**
 * Stock arriving.
 *
 * Lands on an existing lot when the lot number matches, and creates one
 * otherwise. Merging re-prices the lot to the quantity-weighted average of what
 * was there and what arrived, because the two costs are both true of the drawer
 * now and neither is true of all of it.
 *
 * A merge is refused when the expiry dates differ. The same lot number from the
 * same manufacturer carries the same expiry, so a difference means either the
 * earlier entry was wrong or this is a different production run that was typed
 * with the same number — and both are a person's decision, not a default. Silently
 * moving the date would apply the new one to stock received under the old.
 */
export async function receiveStock(
  actor: Actor,
  productId: string,
  input: ReceiveInput
): Promise<StockWriteResult> {
  // Coerced before the transaction opens. A rejected value must not cost a row
  // lock, and validating outside means the lock is held only while the write is
  // actually happening.
  const receivedAt = resolveReceivedAt(input.receivedAt);
  const quantity = toInteger(input.quantity, 'the quantity', PRODUCT_LIMITS.quantity);
  const costPrice = toMoneyString(input.costPrice, COST_PRICE);
  const expiryDate = toDateOnlyOrNull(input.expiryDate, 'the expiry date');

  return withTransaction(async (client) => {
    const locked = await lockProduct(client, actor.pharmacyId, productId);
    if (locked === null) throw notFound('product');

    const existing = await findBatchByLot(
      client,
      actor.pharmacyId,
      productId,
      input.lotNumber
    );

    let batch: BatchRow;
    let merged: boolean;

    if (existing === null) {
      batch = await insertBatch(client, {
        pharmacyId: actor.pharmacyId,
        inventoryId: productId,
        lotNumber: input.lotNumber,
        expiryDate,
        quantity,
        costPrice,
        receivedAt,
      });
      merged = false;
    } else {
      if (existing.expiryDate !== expiryDate) {
        throw new HttpError(
          409,
          `Lot ${input.lotNumber} is already recorded with expiry ` +
            `${existing.expiryDate ?? 'no date'}. Receiving it with ` +
            `${expiryDate ?? 'no date'} would change the expiry of stock already on ` +
            'the shelf. Use a different lot number, or correct the existing batch first.',
          { code: 'lot_expiry_conflict' }
        );
      }
      const updated = await mergeIntoBatch(client, existing.id, quantity, costPrice);
      if (updated === null) throw notFound('batch');
      batch = updated;
      merged = true;
    }

    await insertMovement(client, {
      pharmacyId: actor.pharmacyId,
      inventoryId: productId,
      batchId: batch.id,
      saleId: null,
      movementType: 'receive',
      quantityChange: quantity,
      quantityAfter: batch.quantity,
      reason: input.reason ?? null,
      note: input.note ?? null,
      performedBy: actor.userId,
    });

    // Re-read, because `locked` was taken before the batch write and the
    // derived columns have moved since. Returning the locked copy would report
    // the stock level this receive was supposed to change.
    const product = await findProductById(client, actor.pharmacyId, productId);
    if (product === null) throw notFound('product');

    return {
      product,
      batch,
      movementType: 'receive' as const,
      quantityChange: quantity,
      quantityAfter: batch.quantity,
      merged,
    };
  });
}

/**
 * Corrects a batch to a counted quantity.
 *
 * The reason is mandatory and enforced here rather than in the schema, because
 * the schema cannot say why: an adjustment with no reason recorded is
 * indistinguishable from stock that walked out. `quantity_change` is derived
 * from the difference, so the ledger holds the movement and not just the
 * destination.
 *
 * Adjusting to the quantity the batch already holds is refused. The ledger
 * checks `quantity_change <> 0`, so it would fail anyway — but as a database
 * error rather than as a sentence the person can act on.
 */
export async function adjustBatch(
  actor: Actor,
  productId: string,
  batchId: string,
  input: AdjustInput
): Promise<StockWriteResult> {
  // Zero is allowed here and not in `PRODUCT_LIMITS.quantity`: a stocktake that
  // finds an empty box is an adjustment, and refusing it would send the
  // pharmacist to the write-off form to describe something that was counted
  // rather than damaged. Both are owner-only, so nothing is being escaped.
  const counted = toInteger(input.quantity, 'the counted quantity', {
    min: 0,
    max: PRODUCT_LIMITS.quantity.max,
  });

  return withTransaction(async (client) => {
    const locked = await lockProduct(client, actor.pharmacyId, productId);
    if (locked === null) throw notFound('product');

    const batch = await findBatch(client, actor.pharmacyId, batchId);
    if (batch === null || batch.inventoryId !== productId) throw notFound('batch');

    const change = counted - batch.quantity;
    if (change === 0) {
      throw new HttpError(
        400,
        `That batch already holds ${batch.quantity} units, so there is nothing to adjust`,
        { code: 'no_change' }
      );
    }

    const updated = await setBatchQuantity(client, batch.id, counted);
    if (updated === null) throw notFound('batch');

    await insertMovement(client, {
      pharmacyId: actor.pharmacyId,
      inventoryId: productId,
      batchId: batch.id,
      saleId: null,
      movementType: 'adjust',
      quantityChange: change,
      quantityAfter: updated.quantity,
      reason: input.reason,
      note: input.note,
      performedBy: actor.userId,
    });

    const product = await findProductById(client, actor.pharmacyId, productId);
    if (product === null) throw notFound('product');

    return {
      product,
      batch: updated,
      movementType: 'adjust' as const,
      quantityChange: change,
      quantityAfter: updated.quantity,
      merged: false,
    };
  });
}

/**
 * Removes stock that cannot be sold: expired, damaged, or lost.
 *
 * The batch row survives at whatever quantity is left. Deleting it would break
 * the `sale_item_batches` rows that point at it, and those rows are the recall
 * trail — the record of who was sold what from this lot. A write-off that
 * erased the lot would erase the ability to answer that question about sales
 * already made.
 */
export async function writeOffBatch(
  actor: Actor,
  productId: string,
  batchId: string,
  input: WriteOffInput
): Promise<StockWriteResult> {
  // Coerced outside the transaction, and null rather than defaulted here: how
  // many units to remove depends on how many the batch holds, which is not known
  // until the row is read under the lock.
  const requested =
    input.quantity === undefined
      ? null
      : toInteger(input.quantity, 'the quantity to write off', PRODUCT_LIMITS.quantity);

  return withTransaction(async (client) => {
    const locked = await lockProduct(client, actor.pharmacyId, productId);
    if (locked === null) throw notFound('product');

    const batch = await findBatch(client, actor.pharmacyId, batchId);
    if (batch === null || batch.inventoryId !== productId) throw notFound('batch');

    // Omitted means the whole batch, which is the common case: a shelf of
    // expired stock goes out at once.
    const removing = requested ?? batch.quantity;
    if (removing <= 0) {
      // Caught here rather than left to the ledger's `quantity_change <> 0`
      // check, which would answer as a 500 with a constraint name in it.
      throw new HttpError(400, 'That batch holds no stock, so there is nothing to write off', {
        code: 'batch_empty',
      });
    }
    if (removing > batch.quantity) {
      throw new HttpError(
        400,
        `That batch holds ${batch.quantity} units, so ${removing} cannot be written off`,
        { code: 'exceeds_batch_quantity' }
      );
    }

    const updated = await setBatchQuantity(client, batch.id, batch.quantity - removing);
    if (updated === null) throw notFound('batch');

    await insertMovement(client, {
      pharmacyId: actor.pharmacyId,
      inventoryId: productId,
      batchId: batch.id,
      saleId: null,
      movementType: 'write_off',
      // Negative: stock left. The ledger's sign is what makes it summable.
      quantityChange: -removing,
      quantityAfter: updated.quantity,
      reason: input.reason,
      note: input.note,
      performedBy: actor.userId,
    });

    const product = await findProductById(client, actor.pharmacyId, productId);
    if (product === null) throw notFound('product');

    return {
      product,
      batch: updated,
      movementType: 'write_off' as const,
      quantityChange: -removing,
      quantityAfter: updated.quantity,
      merged: false,
    };
  });
}

export async function listMovements(
  pharmacyId: string,
  productId: string,
  limit: number
): Promise<MovementRow[]> {
  const product = await findProductById(poolSql, pharmacyId, productId);
  if (product === null) throw notFound('product');
  return queryMovements(poolSql, pharmacyId, productId, limit);
}

/**
 * The recall trail for one batch: every sale that contained it, and who to call.
 *
 * Contacts are grouped by phone number, because one person may have bought from
 * the lot twice and calling them twice is not a better recall. Sales with no
 * patient are counted separately rather than dropped: a counter sale to a
 * walk-in genuinely cannot be traced, and a recall that reports eight contacts
 * without mentioning the four untraceable sales overstates what was achieved.
 */
export function contactsFor(sales: readonly RecallSaleRow[]): {
  contacts: RecallContact[];
  untraceableSales: number;
} {
  const byPhone = new Map<string, RecallContact>();
  const byName = new Map<string, RecallContact>();
  let untraceableSales = 0;

  for (const sale of sales) {
    if (sale.patientName === null && sale.patientPhone === null) {
      untraceableSales += 1;
      continue;
    }
    const key = sale.patientPhone ?? `name:${sale.patientName ?? 'unknown'}`;
    const bucket = sale.patientPhone === null ? byName : byPhone;
    const existing = bucket.get(key);
    if (existing === undefined) {
      bucket.set(key, {
        name: sale.patientName ?? 'Patient name not recorded',
        phone: sale.patientPhone,
        sales: 1,
      });
    } else {
      existing.sales += 1;
    }
  }

  const contacts = [...byPhone.values(), ...byName.values()];
  // Phone-holders first: they are the ones a recall can actually reach.
  contacts.sort((left, right) => {
    if (left.phone !== null && right.phone === null) return -1;
    if (left.phone === null && right.phone !== null) return 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return { contacts, untraceableSales };
}

export async function recallBatch(
  pharmacyId: string,
  productId: string,
  batchId: string
): Promise<RecallResult> {
  const product = await findProductById(poolSql, pharmacyId, productId);
  if (product === null) throw notFound('product');

  const batch = await findBatch(poolSql, pharmacyId, batchId);
  if (batch === null || batch.inventoryId !== productId) throw notFound('batch');

  const sales = await recallTrace(poolSql, pharmacyId, batchId);
  const { contacts, untraceableSales } = contactsFor(sales);
  return { product, batch, sales, contacts, untraceableSales };
}
