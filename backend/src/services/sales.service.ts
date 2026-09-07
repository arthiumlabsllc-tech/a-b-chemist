import {
  MAX_LINE_QUANTITY,
  decimalStringFromPesewas,
  floorDiv,
  isTaxError,
  pesewasFromDecimalString,
  priceBasket,
  rateDecimalString,
  rateLabel,
  sellingUnitPricePesewas,
  baseUnitsSold,
  MAX_BASE_UNITS_PER_LINE,
  type PricedBasket,
} from 'a-and-b-chemist-shared';
import { config, type GatewayMode } from '../config';
import { poolSql, withTransaction, type Sql } from '../database/pool';
import {
  findProductById,
  insertMovement,
  listBatchesForProduct,
  listBatchesHoldingStock,
  listCategories,
  listProducts,
  lockProduct,
  setBatchQuantity,
  type BatchRow,
  type ProductFilters,
  type ProductRow,
} from '../repositories/inventory.repository';
import {
  findSaleByClientSaleId,
  findSaleById,
  findSalePayment,
  insertSale,
  insertSaleItem,
  insertSaleItemBatch,
  insertSalePayment,
  listSaleItemBatches,
  listSaleItems,
  listSalePayments,
  listSales as querySales,
  lockSale,
  markSaleVoided,
  nextSaleNumber,
  patientExists,
  updateSalePaymentStatus,
  updateSaleSettlement,
  type SaleFilters,
  type SaleItemBatchRow,
  type SaleItemRow,
  type SaleListItem,
  type SalePaymentRow,
  type SaleRow,
} from '../repositories/sales.repository';
import { findUserById, listStaff } from '../repositories/users.repository';
import {
  DISCOUNT,
  PAYMENT_AMOUNT,
  toEnumMember,
  toInteger,
  toMoneyString,
  toText,
  toTextOrNull,
} from '../utils/coerce';
import { allocate, sellableUnits } from '../utils/fefo';
import { HttpError, notFound } from '../utils/http';
import { can, type UserRole } from '../utils/permissions';
import { newPaymentReference } from '../utils/reference';
import {
  SALE_PAYMENT_METHODS,
  SELL_UNITS,
  type SalePaymentMethod,
  type SaleStatus,
  type SellUnit,
  type VatTreatment,
} from '../utils/schema-enums';
import { settle, tenderFault, type Tender } from '../utils/settlement';
import { taxSettingsForPricing } from './tax-settings.service';
import type { Actor } from './inventory.service';

/**
 * The point-of-sale write path.
 *
 * ## The seven steps, and why they are one transaction
 *
 * A completed sale writes a `sales` row, its `sale_items`, a `sale_item_batches`
 * row per lot drawn, a decrement per batch, a `stock_movements` row per decrement,
 * the tenders, and the settlement. Those are seven kinds of row and they are one
 * fact: this basket left this drawer for this money. Written apart, a failure
 * between two of them leaves a fact half recorded — stock gone with no sale, or a
 * sale with no stock movement, which is the one thing a pharmacy cannot reconstruct
 * afterwards. `withTransaction` commits only on a normal return, so any throw
 * anywhere in here unwinds all seven.
 *
 * ## The gateway is deliberately not in that transaction
 *
 * Charging a wallet is a network call to a third party. Inside the transaction it
 * would hold row locks on every product in the basket for as long as Paystack takes
 * to answer, and a gateway timeout would roll back a sale whose stock had already
 * been counted out. So the sale is written and committed first, with the mobile
 * money tender `pending`, and the charge happens afterwards in its own error
 * handling. A gateway failure then leaves a pending sale with stock drawn — which
 * is a true state the till can show and the operator can resolve by taking cash or
 * voiding — rather than a bare 500 that gives no idea whether the sale exists.
 *
 * ## What is refused, and with which status
 *
 * Insufficient stock answers **409**, not 400. The request is well formed; the
 * drawer is short. The distinction is functional rather than pedantic: the offline
 * queue in Phase 9 must not retry a 400 (the basket needs a person) and should
 * retry a 409 (stock may be received, or another till may void). Landmine 3 in
 * BRIEF.md is the same argument about 500s.
 *
 * ## Not here yet
 *
 * `sales.patient_id` is accepted and validated but nothing populates it: patient
 * records are Phase 8, and a till with no patient picker would only ever send null.
 * Refunds are the same — `refunded` and `partially_refunded` are in the enum and a
 * void reverses its tenders, but taking money back without cancelling the sale is
 * not built.
 */

/** Every field limit the till's requests are held to, in one table. */
export const SALE_LIMITS = {
  /** Lines on one basket. A community pharmacy sale is a handful of items. */
  lines: { min: 1, max: 100 },
  quantity: { min: 1, max: MAX_LINE_QUANTITY },
  /** `sales.client_sale_id`. A UUID from the till, but not assumed to be one. */
  clientSaleId: { min: 8, max: 128 },
  voidReason: { min: 3, max: 500 },
  /**
   * `sale_payments.reference`, which on a cash tender is a note the operator
   * typed and on a mobile money tender is a gateway binding this server minted.
   * Only the first of those ever arrives in a request, so only the first is
   * limited here; see `referenceFor`.
   */
  note: { min: 1, max: 200 },
  discountReason: { min: 3, max: 200 },
} as const;

// ---------------------------------------------------------------------------
// Inputs. `unknown` throughout, coerced here rather than trusted by the route:
// express-validator checks shape, but the arithmetic guards live in the shared
// package and Phase 9's offline queue replays baskets that no validator saw.
// ---------------------------------------------------------------------------

export interface SaleLineInput {
  productId: unknown;
  quantity: unknown;
  /** Omitted means the product's own `default_sell_unit`. */
  sellUnit?: unknown;
}

export interface SalePaymentInput {
  method: unknown;
  amount: unknown;
  reference?: unknown;
}

export interface CreateSaleInput {
  lines: unknown;
  discount?: unknown;
  discountReason?: unknown;
  /** May be empty: a customer who cannot pay leaves the sale pending. */
  payments?: unknown;
  patientId?: unknown;
  approvedBy?: unknown;
  /** Supplied by the till so a lost response cannot double-sell on replay. */
  clientSaleId?: unknown;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The money on a priced basket, in the decimal strings the API speaks. */
export interface BasketView {
  subtotal: string;
  discount: string;
  discountReason: string | null;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  taxTotal: string;
  taxableBase: string;
  total: string;
  /** The four figures snapshotted onto the sale beside the money. */
  vatRate: string;
  nhilRate: string;
  getfundRate: string;
  taxInclusivePricing: boolean;
  /** `15%`, `2.5%`, `2.5%`. GRA requires the receipt to name what it charged. */
  vatLabel: string;
  nhilLabel: string;
  getfundLabel: string;
}

/** One line of a quote: what it would cost, and whether the drawer can cover it. */
export interface QuoteLine {
  productId: string;
  name: string;
  code: string;
  sellUnit: SellUnit;
  /** Selling units, as the receipt will read. */
  quantity: number;
  /** Base units, as the drawer will lose. */
  baseUnits: number;
  unitPrice: string;
  lineGross: string;
  lineDiscount: string;
  taxableBase: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  lineTotal: string;
  vatTreatment: string;
  requiresPrescription: boolean;
  /** Selling units available. What the till shows beside the quantity stepper. */
  available: number;
  shortfall: number;
}

export interface QuoteResult {
  lines: QuoteLine[];
  basket: BasketView;
  /** False when any line's shortfall is above zero. */
  canFulfil: boolean;
}

/** A stored sale and everything hanging off it. */
export interface SaleDetail {
  sale: SaleRow;
  items: SaleItemRow[];
  batches: Array<SaleItemBatchRow & { inventoryId: string }>;
  payments: SalePaymentRow[];
  servedByName: string | null;
  approvedByName: string | null;
}

export interface CreateSaleResult {
  detail: SaleDetail;
  /**
   * True when this `clientSaleId` had already been recorded and the stored sale is
   * being handed back. Not an error: the till lost the response, and the answer to
   * "did that sale go through" is the sale.
   */
  replayed: boolean;
}

/** One lot a line drew from, planned before anything is written. */
interface PlannedDraw {
  batchId: string;
  lotNumber: string;
  quantity: number;
  /** This batch's cost, snapshotted. Never read back from the product row. */
  unitCost: string;
  /** The batch's quantity after this draw, for the ledger row written beside it. */
  quantityAfter: number;
}

interface PlannedLine {
  product: ProductRow;
  sellUnit: SellUnit;
  quantity: number;
  baseUnits: number;
  unitPricePesewas: number;
  draws: PlannedDraw[];
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

function badRequest(message: string, code: string, details?: unknown): HttpError {
  return new HttpError(400, message, details === undefined ? { code } : { code, details });
}

/**
 * A stored figure this service could not use.
 *
 * 500 and not 400: `unit_price` and `pack_size` are ours, written by the inventory
 * path and validated when they were written. An operator at the counter cannot fix
 * either, and a 400 would tell them their basket was wrong when it was not. The
 * message names the product and withholds the underlying figure, because the error
 * middleware shows a 500's message only outside production.
 */
function unusableProduct(product: ProductRow): HttpError {
  return new HttpError(
    500,
    `${product.name} has a price or pack size this till cannot use. Ask the owner to open the product and save it again.`,
    { code: 'product_unpriceable', details: { productId: product.id } }
  );
}

/**
 * Derives the two figures a line needs from the product row and the request.
 *
 * Both come from `selling-price.ts` in the shared package, which is the only place
 * the pack rule lives. `inventory.unit_price` is per base unit and a line may sell
 * packs, so the price is multiplied and the quantity is converted to base units; the
 * shared module's header carries the argument for that direction and the reason a
 * wrong guess is a tenfold error rather than a rounding one.
 *
 * The caller's own inputs are validated before either conversion is attempted, and
 * the base-unit ceiling is checked here rather than left to `baseUnitsSold`. That
 * ordering is what lets the two `catch` blocks below mean what they say: after it,
 * the only thing either conversion can fail on is our stored data.
 */
function priceLine(
  product: ProductRow,
  rawQuantity: unknown,
  rawSellUnit: unknown,
  position: number
): { quantity: number; sellUnit: SellUnit; unitPricePesewas: number; baseUnits: number } {
  const label = `line ${position + 1}`;

  const quantity = toInteger(rawQuantity, `the quantity on ${label}`, SALE_LIMITS.quantity);
  const sellUnit: SellUnit =
    rawSellUnit === undefined || rawSellUnit === null || rawSellUnit === ''
      ? product.defaultSellUnit
      : toEnumMember(rawSellUnit, SELL_UNITS, `the selling unit on ${label}`);

  // Checked before the conversion so that the refusal is about the basket and reads
  // as one. Left to `baseUnitsSold` it would arrive as the engine's own wording,
  // which cannot name the line.
  const worstCase = sellUnit === 'pack' ? quantity * product.packSize : quantity;
  if (Number.isSafeInteger(worstCase) && worstCase > MAX_BASE_UNITS_PER_LINE) {
    throw badRequest(
      `${label} moves more units than a sale can record. Reduce the quantity or sell singles.`,
      'line_out_of_range',
      { line: position }
    );
  }

  let unitPricePesewas: number;
  let baseUnits: number;
  try {
    const stored = pesewasFromDecimalString(product.unitPrice, 'the unit price');
    unitPricePesewas = sellingUnitPricePesewas({
      baseUnitPricePesewas: stored,
      packSize: product.packSize,
      sellUnit,
    });
    baseUnits = baseUnitsSold({ quantity, packSize: product.packSize, sellUnit });
  } catch (error) {
    // A `TaxError` naming `quantity` would be the caller's fault, but the ceiling
    // above means that branch is already handled, and nothing else here is theirs.
    if (isTaxError(error) && error.field === 'quantity') {
      throw badRequest(error.message, error.code, { line: position });
    }
    throw unusableProduct(product);
  }

  return { quantity, sellUnit, unitPricePesewas, baseUnits };
}

/** A basket line for the shared pricer. The id is the position, and is unique. */
function toBasketLine(
  position: number,
  priced: { quantity: number; unitPricePesewas: number },
  product: ProductRow
): { id: string; quantity: number; unitPricePesewas: number; vatTreatment: ProductRow['vatTreatment'] } {
  return {
    // The position rather than the product id, because two lines may hold the same
    // product — a strip of ten and three loose tablets of it — and the pricer
    // refuses a repeated id. Results come back in input order, so the till
    // correlates by position and nothing needs a client-supplied key.
    id: String(position),
    quantity: priced.quantity,
    unitPricePesewas: priced.unitPricePesewas,
    vatTreatment: product.vatTreatment,
  };
}

function basketView(basket: PricedBasket): BasketView {
  const { rates } = basket;
  return {
    subtotal: decimalStringFromPesewas(basket.subtotal),
    discount: decimalStringFromPesewas(basket.discount),
    discountReason: basket.discountReason,
    vatAmount: decimalStringFromPesewas(basket.vatAmount),
    nhilAmount: decimalStringFromPesewas(basket.nhilAmount),
    getfundAmount: decimalStringFromPesewas(basket.getfundAmount),
    taxTotal: decimalStringFromPesewas(basket.taxTotal),
    taxableBase: decimalStringFromPesewas(basket.taxableBase),
    total: decimalStringFromPesewas(basket.total),
    vatRate: rateDecimalString(rates.vatRate),
    nhilRate: rateDecimalString(rates.nhilRate),
    getfundRate: rateDecimalString(rates.getfundRate),
    taxInclusivePricing: rates.taxInclusivePricing,
    vatLabel: rateLabel(rates.vatRate),
    nhilLabel: rateLabel(rates.nhilRate),
    getfundLabel: rateLabel(rates.getfundRate),
  };
}

/** The lines of a request, coerced and de-duplicated enough to lock safely. */
function readLineInputs(raw: unknown): SaleLineInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('A sale needs at least one line', 'basket_has_no_value');
  }
  if (raw.length > SALE_LIMITS.lines.max) {
    throw badRequest(
      `A sale can hold ${SALE_LIMITS.lines.max} lines at most`,
      'basket_too_large'
    );
  }
  return raw.map((entry, position) => {
    if (entry === null || typeof entry !== 'object') {
      throw badRequest(`Line ${position + 1} is not an item`, 'validation_failed');
    }
    const line = entry as Record<string, unknown>;
    return {
      productId: line.productId,
      quantity: line.quantity,
      sellUnit: line.sellUnit,
    };
  });
}

function readPaymentInputs(raw: unknown): SalePaymentInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw badRequest('Payments must be a list', 'validation_failed');
  }
  return raw.map((entry, position) => {
    if (entry === null || typeof entry !== 'object') {
      throw badRequest(`Payment ${position + 1} is not a tender`, 'validation_failed');
    }
    const payment = entry as Record<string, unknown>;
    return { method: payment.method, amount: payment.amount, reference: payment.reference };
  });
}

/**
 * Coerces one tender and decides its status from its method.
 *
 * The status is never taken from the request. Cash is `succeeded` the moment it is
 * recorded, because the money is in the drawer or it is not and no third party will
 * ever say otherwise; mobile money is `pending` until the gateway confirms it, which
 * is what stops a sale completing on a charge nobody has authorised. Letting a
 * client send `status: 'succeeded'` beside `method: 'momo'` would hand the till the
 * ability to settle a sale with money that never moved.
 *
 * The field it reads is called `note` and not `reference`, because that is all a
 * caller can supply: whatever the till sends beside a mobile money tender is
 * thrown away and replaced by a reference this server mints, in `referenceFor`.
 * Naming the field for the column it does *not* always fill would invite a route
 * to validate a value that is then discarded.
 */
function readTender(
  input: SalePaymentInput,
  position: number
): { method: SalePaymentMethod; amountPesewas: number; amount: string; note: string | null; status: 'succeeded' | 'pending' } {
  const label = `payment ${position + 1}`;
  const method = toEnumMember(input.method, SALE_PAYMENT_METHODS, `the method on ${label}`);
  const amount = toMoneyString(input.amount, PAYMENT_AMOUNT);
  // Not coerced at all on a mobile money tender. Validating a value that is about
  // to be discarded would refuse a sale over the length of a string nobody reads,
  // and would be the only place in this path where a client-supplied field on a
  // wallet tender has any effect.
  const note =
    method === 'momo' ||
    input.reference === undefined ||
    input.reference === null ||
    input.reference === ''
      ? null
      : toText(input.reference, `the note on ${label}`, SALE_LIMITS.note.max);

  return {
    method,
    amount,
    amountPesewas: pesewasFromDecimalString(amount, `the amount on ${label}`),
    note,
    status: method === 'cash' ? 'succeeded' : 'pending',
  };
}

/**
 * The reference a tender is written with.
 *
 * For mobile money it is minted here, and whatever the client sent is discarded.
 * That is not tidiness — it is the whole premise of the webhook path. A webhook
 * arrives carrying a reference and nothing else: no pharmacy, no sale, no tender
 * id, because Paystack knows the merchant account and has never heard of a
 * tenant. `findSalePaymentByReference` therefore has to answer with exactly one
 * row, and it can only do that if the reference was chosen here, once, and never
 * again by anybody else. A client that could pick its own references could make
 * two tenders share one, and the lookup takes the earliest match — so one charge
 * would settle the other's tender and both would look correct on the receipt.
 *
 * For cash the operator's note is kept, because on a cash tender `reference` is
 * not a gateway binding at all. It is the free text the drawer reconciliation
 * needs, and the lookup above is restricted to `method = 'momo'` precisely so
 * that text can never be mistaken for one.
 *
 * ## Why a retry of a wallet charge is not another tender
 *
 * `addPayment` mints a fresh reference every time, which is correct for what it
 * means — a new tender — and wrong for what an operator might think it means
 * when a mobile money prompt times out. The retry for that is the `verify` route,
 * which asks Paystack about the tender that already exists. Calling `addPayment`
 * instead leaves the first tender pending and starts a second charge, and a
 * customer who approves both is debited twice. The routes are documented with
 * that distinction for this reason.
 */
function referenceFor(
  tender: { method: SalePaymentMethod; note: string | null },
  saleNumber: string
): string | null {
  return tender.method === 'momo' ? newPaymentReference(saleNumber) : tender.note;
}

/** How many selling units of a product the drawer can actually hand over. */
function availableInSellUnits(
  batches: readonly BatchRow[],
  sellUnit: SellUnit,
  packSize: number,
  today: string
): number {
  const base = sellableUnits(batches, today);
  if (sellUnit !== 'pack') return base;
  // Floored, and reported in the unit the till is counting in: a drawer holding 15
  // tablets cannot sell 1.5 strips, and "1 available" is the answer that stops the
  // operator pressing the stepper again.
  return floorDiv(base, packSize).quotient;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function detail(sql: Sql, pharmacyId: string, saleId: string): Promise<SaleDetail> {
  const sale = await findSaleById(sql, pharmacyId, saleId);
  if (sale === null) throw notFound('sale');

  const [items, batches, payments] = await Promise.all([
    listSaleItems(sql, saleId),
    listSaleItemBatches(sql, saleId),
    listSalePayments(sql, saleId),
  ]);

  // Names are looked up rather than joined so the three queries above stay the ones
  // the receipt needs. Both are single-row reads by primary key.
  const [servedBy, approvedBy] = await Promise.all([
    findUserById(sale.servedBy),
    sale.approvedBy === null ? Promise.resolve(null) : findUserById(sale.approvedBy),
  ]);

  return {
    sale,
    items,
    batches,
    payments,
    servedByName: servedBy === null ? null : servedBy.fullName,
    approvedByName: approvedBy === null ? null : approvedBy.fullName,
  };
}

export async function listSales(
  pharmacyId: string,
  filters: SaleFilters
): Promise<{ sales: SaleListItem[] }> {
  return { sales: await querySales(poolSql, pharmacyId, filters) };
}

export async function getSale(pharmacyId: string, saleId: string): Promise<SaleDetail> {
  return detail(poolSql, pharmacyId, saleId);
}

/**
 * Prices a basket without touching anything.
 *
 * Write-free on purpose, and that is a production-diagnosis tool as much as a
 * convenience for the till: BRIEF.md's landmine 9 keeps endpoints like this
 * un-rate-limited because when a sale will not go through, being able to ask "what
 * would this basket have cost" without a session, a lock or a write is how the
 * difference between a pricing bug and a stock bug gets found at a counter.
 *
 * Reads products without locking them. A quote is a question about the present and
 * not a reservation, so it must not be able to block a sale — and two tills quoting
 * the same product must not serialise on each other.
 */
export async function quoteSale(
  pharmacyId: string,
  input: { lines: unknown; discount?: unknown; discountReason?: unknown },
  today: string
): Promise<QuoteResult> {
  const settings = await taxSettingsForPricing(pharmacyId);
  const lines = readLineInputs(input.lines);

  const resolved: Array<{ product: ProductRow; priced: ReturnType<typeof priceLine> }> = [];
  for (const [position, line] of lines.entries()) {
    const productId = toText(line.productId, `the product on line ${position + 1}`, 36);
    const product = await findProductById(poolSql, pharmacyId, productId);
    if (product === null) throw notFound('product');
    if (!product.isActive) {
      throw badRequest(`${product.name} is not on sale`, 'product_inactive', { line: position });
    }
    resolved.push({ product, priced: priceLine(product, line.quantity, line.sellUnit, position) });
  }

  const basket = priceBasket({
    settings,
    lines: resolved.map(({ product, priced }, position) =>
      toBasketLine(position, priced, product)
    ),
    ...(input.discount === undefined || input.discount === null || input.discount === ''
      ? {}
      : {
          discountPesewas: pesewasFromDecimalString(
            toMoneyString(input.discount, DISCOUNT),
            'the discount'
          ),
          discountReason:
            typeof input.discountReason === 'string' ? input.discountReason : null,
        }),
  });

  const quoteLines: QuoteLine[] = [];
  for (const [position, { product, priced }] of resolved.entries()) {
    const batches = await listBatchesForProduct(poolSql, pharmacyId, product.id);
    const available = availableInSellUnits(batches, priced.sellUnit, product.packSize, today);
    const pricedLine = basket.lines[position];
    if (pricedLine === undefined) {
      // Unreachable: the pricer returns one line per input, in order. Thrown rather
      // than papered over, because silently quoting a line as zero is worse than
      // failing.
      throw new Error(`the pricer returned no line for position ${position}`);
    }
    quoteLines.push({
      productId: product.id,
      name: product.name,
      code: product.code,
      sellUnit: priced.sellUnit,
      quantity: priced.quantity,
      baseUnits: priced.baseUnits,
      unitPrice: decimalStringFromPesewas(priced.unitPricePesewas),
      lineGross: decimalStringFromPesewas(pricedLine.lineGross),
      lineDiscount: decimalStringFromPesewas(pricedLine.lineDiscount),
      taxableBase: decimalStringFromPesewas(pricedLine.taxableBase),
      vatAmount: decimalStringFromPesewas(pricedLine.vatAmount),
      nhilAmount: decimalStringFromPesewas(pricedLine.nhilAmount),
      getfundAmount: decimalStringFromPesewas(pricedLine.getfundAmount),
      lineTotal: decimalStringFromPesewas(pricedLine.lineTotal),
      vatTreatment: pricedLine.vatTreatment,
      requiresPrescription: product.requiresPrescription,
      available,
      shortfall: Math.max(0, priced.quantity - available),
    });
  }

  return {
    lines: quoteLines,
    basket: basketView(basket),
    canFulfil: quoteLines.every((line) => line.shortfall === 0),
  };
}

// ---------------------------------------------------------------------------
// Planning. Everything here reads and computes; nothing writes. A basket that
// cannot be fulfilled has to be refused with no row on the database to undo.
// ---------------------------------------------------------------------------

/** A field the operator has to type something into, with a floor on its length. */
function readReason(raw: unknown, label: string, limits: { min: number; max: number }): string {
  const text = toText(raw, label, limits.max);
  if (text.length < limits.min) {
    throw badRequest(`${label} must be at least ${limits.min} characters`, 'validation_failed');
  }
  return text;
}

/**
 * The till's own id for this basket, or null when it did not send one.
 *
 * A floor on the length as well as a ceiling. The ceiling is the column's; the
 * floor is because the id's whole job is to be different every time, and `'1'` is
 * a value two tills reach for on the same day. A collision is not a bug the till
 * can see — it presents as a sale that will not record, answered by the idempotency
 * path handing back somebody else's basket.
 */
function readClientSaleId(raw: unknown): string | null {
  const text = toTextOrNull(raw, 'the client sale id', SALE_LIMITS.clientSaleId.max);
  if (text === null) return null;
  if (text.length < SALE_LIMITS.clientSaleId.min) {
    throw badRequest(
      `The client sale id must be at least ${SALE_LIMITS.clientSaleId.min} characters, so two tills cannot reach the same one`,
      'validation_failed'
    );
  }
  return text;
}

/**
 * The discount on the basket, or null when there is not one.
 *
 * The reason is required here and not only by the pricer. `init.sql` says so on
 * the column — *"Mandatory whenever a discount exists: an unexplained discount is
 * the shape of a leak"* — and there is deliberately no constraint, because a check
 * constraint cannot tell a zero discount with a stale reason from a real one. The
 * pricer enforces non-empty and this enforces the length floor, so a one-letter
 * reason typed to get past a required field is refused rather than stored.
 */
function readDiscount(input: CreateSaleInput): {
  discountPesewas: number;
  discountReason: string;
} | null {
  if (input.discount === undefined || input.discount === null || input.discount === '') {
    return null;
  }
  const discountPesewas = pesewasFromDecimalString(
    toMoneyString(input.discount, DISCOUNT),
    'the discount'
  );
  if (discountPesewas <= 0) {
    throw badRequest('A discount has to be more than zero, or left out', 'discount_not_positive');
  }
  return {
    discountPesewas,
    discountReason: readReason(input.discountReason, 'A reason for the discount', SALE_LIMITS.discountReason),
  };
}

/**
 * Whether the named approver may approve a prescription sale.
 *
 * Decided outside the transaction, and that is not a shortcut. `findUserById`
 * reads through the module-level pool and cannot join a transaction, so a check
 * performed inside one would hold no lock over the row it read and see no
 * snapshot of it — calling that part of the sale's all-or-nothing write would be
 * a claim the code cannot back. Reading it here is honest, and it also refuses a
 * bad id before a single product is locked.
 *
 * The approver may be the person ringing the sale, and that is allowed on
 * purpose for an owner working alone. What is not possible is a member of counter
 * staff approving their own prescription sale, because `prescriptions:approve` is
 * not in the staff permission set at all — the control is on the role, not on the
 * combination, so it holds even on a shift where the owner is the one at the till.
 */
async function resolveApprover(pharmacyId: string, approverId: string): Promise<string> {
  const user = await findUserById(approverId);
  if (user === null || user.pharmacyId !== pharmacyId) throw notFound('approver');
  if (!user.isActive) {
    throw badRequest(
      `${user.fullName} cannot approve a prescription sale: that login is no longer active`,
      'approver_inactive'
    );
  }
  if (!can(user.role, 'prescriptions:approve')) {
    throw badRequest(
      `${user.fullName} cannot approve a prescription sale. A pharmacist or the owner has to.`,
      'approver_not_permitted'
    );
  }
  return user.id;
}

/**
 * A drawer that cannot cover a line, said in the units the operator is counting
 * in and answered with **409**.
 *
 * The status is the point. The request is well formed; the stock is short. The
 * offline queue in Phase 9 decides what to replay from the status alone, and it
 * must not retry a basket that needs a person to change it — so a shortfall has
 * to be distinguishable from a malformed line without reading the message. A 400
 * here would mean every out-of-stock sale sat in the queue forever, and a 500
 * would mean the till treated a stock question as an outage.
 */
function shortOfStock(
  product: ProductRow,
  sellUnit: SellUnit,
  shortfallBase: number,
  batches: readonly BatchRow[],
  today: string,
  position: number
): HttpError {
  const available = availableInSellUnits(batches, sellUnit, product.packSize, today);
  // Rounded up, and reported in selling units. A line short by 3 tablets of a
  // pack of 10 is short by one pack: telling the operator "3 short" on a screen
  // counting strips sends them looking for a number that is not on it.
  const short = sellUnit === 'pack' ? Math.ceil(shortfallBase / product.packSize) : shortfallBase;
  const unit = sellUnit === 'pack' ? 'packs' : 'units';
  return new HttpError(
    409,
    `${product.name}: only ${available} ${unit} left in stock, ${short} fewer than this line needs.`,
    {
      code: 'insufficient_stock',
      details: { line: position, productId: product.id, available, shortfall: short },
    }
  );
}

/**
 * Locks every product the basket names, prices every line, and allocates every
 * line against the drawer — in that order, and all of it before a single write.
 *
 * ## Why the locks come first and in sorted order
 *
 * Two tills selling overlapping baskets each hold a row lock the other wants
 * unless both ask in the same order, and "the order the lines arrived in" is not
 * an order two requests agree on. Sorting by id costs one comparison and removes
 * the deadlock; without it a busy counter hangs for `deadlock_timeout` and then
 * reports a 500 that reads like an outage and is not one.
 *
 * The batches of a product are read only after that product is locked, which is
 * the order `inventory.service.ts` uses for the same reason: an unlocked read
 * beside a locked parent is a read of stock another transaction is free to
 * change before the write lands.
 *
 * ## Why the batch list is a working copy
 *
 * `allocate()` dedupes the batch ids it is given, but it knows nothing about the
 * line before it. Two lines naming the same product — a strip of ten and three
 * loose tablets of it, which is an ordinary basket — would each be handed the
 * same tablets, every individual check would pass, and the drawer would oversell.
 * So the copies are decremented as each line is planned, and the next line is
 * allocated against what is actually still there.
 */
async function planBasket(
  sql: Sql,
  pharmacyId: string,
  lines: readonly SaleLineInput[],
  today: string
): Promise<PlannedLine[]> {
  const resolved = lines.map((line, position) => ({
    position,
    line,
    productId: toText(line.productId, `the product on line ${position + 1}`, 36),
  }));

  const locked = new Map<string, ProductRow>();
  for (const productId of [...new Set(resolved.map((entry) => entry.productId))].sort()) {
    const product = await lockProduct(sql, pharmacyId, productId);
    if (product === null) throw notFound('product');
    locked.set(productId, product);
  }

  const working = new Map<string, BatchRow[]>();
  const planned: PlannedLine[] = [];

  for (const { position, line, productId } of resolved) {
    const product = locked.get(productId);
    if (product === undefined) {
      // Unreachable: every id in `resolved` was locked above. Thrown rather than
      // skipped, because a line silently dropped from a basket is a sale that
      // charges for two items and hands over one.
      throw new Error(`no lock was taken for product ${productId}`);
    }
    if (!product.isActive) {
      throw badRequest(`${product.name} is not on sale`, 'product_inactive', { line: position });
    }

    const priced = priceLine(product, line.quantity, line.sellUnit, position);

    let batches = working.get(productId);
    if (batches === undefined) {
      batches = (await listBatchesForProduct(sql, pharmacyId, productId)).map((batch) => ({
        ...batch,
      }));
      working.set(productId, batches);
    }

    const result = allocate(batches, priced.baseUnits, today);
    if (result.shortfall > 0) {
      throw shortOfStock(product, priced.sellUnit, result.shortfall, batches, today, position);
    }

    const draws: PlannedDraw[] = [];
    for (const allocation of result.allocations) {
      const batch = batches.find((candidate) => candidate.id === allocation.batchId);
      if (batch === undefined) {
        throw new Error('allocate() returned a batch that was not in the list it was given');
      }
      batch.quantity -= allocation.quantity;
      draws.push({
        batchId: allocation.batchId,
        lotNumber: allocation.lotNumber,
        quantity: allocation.quantity,
        unitCost: allocation.unitCost,
        // The copy is already decremented, so this is the figure the ledger row
        // beside the decrement has to carry — and it stays right when the next
        // line draws from the same batch, which is the case a per-line read of
        // the database would get wrong twice over.
        quantityAfter: batch.quantity,
      });
    }

    planned.push({
      product,
      sellUnit: priced.sellUnit,
      quantity: priced.quantity,
      baseUnits: priced.baseUnits,
      unitPricePesewas: priced.unitPricePesewas,
      draws,
    });
  }

  return planned;
}

/** The tenders on a basket, coerced and checked against the total. */
function planTenders(
  totalPesewas: number,
  inputs: readonly SalePaymentInput[],
  existing: readonly Tender[] = []
): { tenders: ReturnType<typeof readTender>[]; settlement: ReturnType<typeof settle> } {
  const tenders = inputs.map(readTender);
  const after = [...existing, ...tenders.map((tender) => ({
    method: tender.method,
    status: tender.status,
    amount: tender.amountPesewas,
  }))];

  // Refused before anything is written, with the sentence the operator has to
  // say out loud. `tenderFault` returns prose rather than a code because every
  // one of these is read at a counter by somebody who has to tell a customer
  // what to do differently.
  const fault = tenderFault(totalPesewas, after);
  if (fault !== null) throw badRequest(fault, 'payment_refused');

  return { tenders, settlement: settle(totalPesewas, after) };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Records a sale: the seven steps, in one transaction.
 *
 * The order inside is deliberate. Everything that can refuse — the locks, the
 * allocation, the pricing, the patient, the approver, the tenders — happens
 * before the first insert, so a refusal unwinds a transaction that has written
 * nothing. The receipt number is taken last of all, because `nextSaleNumber`
 * holds a pharmacy-wide advisory lock until commit and every read before it
 * would otherwise be inside that lock.
 *
 * That ordering is also what keeps two concurrent sales from deadlocking: every
 * sale takes product locks in sorted order first and the advisory lock after, so
 * no two of them ever wait on each other in opposite orders. The inventory paths
 * take a single product lock and never take the advisory one, so they cannot
 * close a cycle either.
 *
 * ## Two clock values, and why they are not one
 *
 * `today` is the FEFO boundary — the date an expiry is judged against — and `now`
 * is the instant the money arrived. They are the same moment in production and are
 * kept apart so a test can put a sale at 23:59 on the day a batch expires, which
 * is the only way to find out whether the boundary is inclusive without waiting
 * for a year to end. Reading either from the clock in here would mean mocking one
 * to test the other.
 */
export async function createSale(
  actor: Actor,
  input: CreateSaleInput,
  today: string,
  now: string
): Promise<CreateSaleResult> {
  const lines = readLineInputs(input.lines);
  const clientSaleId = readClientSaleId(input.clientSaleId);
  const patientId = toTextOrNull(input.patientId, 'the patient id', 36);
  const approverId = toTextOrNull(input.approvedBy, 'the approver', 36);
  const discount = readDiscount(input);
  const approver = approverId === null ? null : await resolveApprover(actor.pharmacyId, approverId);
  const settings = await taxSettingsForPricing(actor.pharmacyId);

  try {
    return await withTransaction(async (client) => {
      // The idempotency read, inside the transaction rather than before it. A
      // check outside would answer "not yet recorded" and then block on the
      // insert anyway; in here it sees the same snapshot the insert is made
      // against.
      if (clientSaleId !== null) {
        const recorded = await findSaleByClientSaleId(client, actor.pharmacyId, clientSaleId);
        if (recorded !== null) {
          // Handed back as a success and not an error. The till lost the response
          // to a sale that went through, and the answer to "did that sale record?"
          // is the sale — a 409 here would leave the operator staring at a
          // refusal for money already in the drawer and stock already drawn.
          return { detail: await detail(client, actor.pharmacyId, recorded.id), replayed: true };
        }
      }

      const planned = await planBasket(client, actor.pharmacyId, lines, today);

      if (patientId !== null && !(await patientExists(client, actor.pharmacyId, patientId))) {
        throw notFound('patient');
      }

      const basket = priceBasket({
        settings,
        lines: planned.map((line, position) => toBasketLine(position, line, line.product)),
        ...(discount === null ? {} : { discountPesewas: discount.discountPesewas, discountReason: discount.discountReason }),
      });

      // Checked after pricing rather than before, so a basket that is both
      // unaffordable and unapproved is refused on the stock — the thing the
      // operator can act on — and not on a signature they have to go and find
      // first for a sale that could not have been rung anyway.
      const needingApproval = planned.filter((line) => line.product.requiresPrescription);
      if (needingApproval.length > 0 && approver === null) {
        const names = needingApproval.map((line) => line.product.name);
        throw badRequest(
          `${names.join(', ')} needs a pharmacist's or the owner's approval before it can be sold. Name the approver on this sale.`,
          'prescription_needs_approver',
          { products: needingApproval.map((line) => line.product.id) }
        );
      }

      const { tenders, settlement } = planTenders(basket.total, readPaymentInputs(input.payments));

      const saleNumber = await nextSaleNumber(client, actor.pharmacyId);
      const sale = await insertSale(client, {
        pharmacyId: actor.pharmacyId,
        saleNumber,
        status: settlement.status,
        servedBy: actor.userId,
        approvedBy: approver,
        patientId,
        subtotal: decimalStringFromPesewas(basket.subtotal),
        discount: decimalStringFromPesewas(basket.discount),
        discountReason: basket.discountReason,
        vatAmount: decimalStringFromPesewas(basket.vatAmount),
        nhilAmount: decimalStringFromPesewas(basket.nhilAmount),
        getfundAmount: decimalStringFromPesewas(basket.getfundAmount),
        taxTotal: decimalStringFromPesewas(basket.taxTotal),
        total: decimalStringFromPesewas(basket.total),
        amountPaid: decimalStringFromPesewas(settlement.paidPesewas),
        changeGiven: decimalStringFromPesewas(settlement.changePesewas),
        vatRate: rateDecimalString(basket.rates.vatRate),
        nhilRate: rateDecimalString(basket.rates.nhilRate),
        getfundRate: rateDecimalString(basket.rates.getfundRate),
        taxInclusivePricing: basket.rates.taxInclusivePricing,
        clientSaleId,
      });

      // The batches this sale ends up leaving behind, and the figure each is left
      // at. Written once per batch after every line, so a batch two lines drew
      // from is decremented once and the trigger on `inventory_batches` fires once
      // for it rather than twice.
      const finalQuantities = new Map<string, number>();

      for (const [position, line] of planned.entries()) {
        const pricedLine = basket.lines[position];
        if (pricedLine === undefined) {
          throw new Error(`the pricer returned no line for position ${position}`);
        }

        const item = await insertSaleItem(client, {
          saleId: sale.id,
          inventoryId: line.product.id,
          // Snapshotted, so renaming the product cannot rewrite a receipt that was
          // already printed and already handed to a customer.
          description: line.product.name,
          sellUnit: line.sellUnit,
          quantity: line.quantity,
          unitPrice: decimalStringFromPesewas(line.unitPricePesewas),
          lineGross: decimalStringFromPesewas(pricedLine.lineGross),
          lineDiscount: decimalStringFromPesewas(pricedLine.lineDiscount),
          taxableBase: decimalStringFromPesewas(pricedLine.taxableBase),
          vatAmount: decimalStringFromPesewas(pricedLine.vatAmount),
          nhilAmount: decimalStringFromPesewas(pricedLine.nhilAmount),
          getfundAmount: decimalStringFromPesewas(pricedLine.getfundAmount),
          lineTotal: decimalStringFromPesewas(pricedLine.lineTotal),
          vatTreatment: pricedLine.vatTreatment,
        });

        for (const draw of line.draws) {
          await insertSaleItemBatch(client, {
            saleItemId: item.id,
            batchId: draw.batchId,
            quantity: draw.quantity,
            unitCost: draw.unitCost,
          });

          // Written beside the decrement rather than collected at the end, because
          // `stock_movements.created_at` defaults to `clock_timestamp()` — the one
          // default in this schema that moves inside a transaction — and that is
          // what makes the ledger read back in the order the units left. Batching
          // the movements at the end would still be correct and would read worse.
          await insertMovement(client, {
            pharmacyId: actor.pharmacyId,
            inventoryId: line.product.id,
            batchId: draw.batchId,
            saleId: sale.id,
            movementType: 'sale',
            quantityChange: -draw.quantity,
            quantityAfter: draw.quantityAfter,
            reason: null,
            note: null,
            performedBy: actor.userId,
          });

          finalQuantities.set(draw.batchId, draw.quantityAfter);
        }
      }

      for (const [batchId, quantity] of finalQuantities) {
        const updated = await setBatchQuantity(client, batchId, quantity);
        if (updated === null) {
          // Unreachable: the batch was read under a lock on its product in this
          // same transaction. Left as a throw rather than a skip because the skip
          // would be a decrement the ledger recorded and the drawer did not feel.
          throw new Error(`batch ${batchId} vanished between allocation and write`);
        }
      }

      for (const tender of tenders) {
        await insertSalePayment(client, {
          saleId: sale.id,
          method: tender.method,
          status: tender.status,
          amount: tender.amount,
          reference: referenceFor(tender, sale.saleNumber),
          gatewayResponse: null,
          // Cash is dated the moment it is recorded, because the money is in the
          // drawer or it is not. Mobile money is dated when the gateway confirms
          // it and stays null until then — a `paid_at` on a tender that has not
          // arrived is a receipt claiming money nobody has seen.
          paidAt: tender.status === 'succeeded' ? now : null,
        });
      }

      return { detail: await detail(client, actor.pharmacyId, sale.id), replayed: false };
    });
  } catch (error) {
    // The race the pre-check cannot close: two requests carrying the same
    // `clientSaleId` both read "not recorded" and both insert. One wins and one
    // meets the unique index, which the repository turns into a 409. That 409 is
    // true of the losing request and useless to it — the sale exists, which is
    // what it was asking. So the answer is fetched again outside the rolled-back
    // transaction and handed back as the replay it was.
    if (
      clientSaleId !== null &&
      error instanceof HttpError &&
      error.status === 409 &&
      error.code === 'sale_already_recorded'
    ) {
      const recorded = await findSaleByClientSaleId(poolSql, actor.pharmacyId, clientSaleId);
      if (recorded !== null) {
        return { detail: await detail(poolSql, actor.pharmacyId, recorded.id), replayed: true };
      }
    }
    throw error;
  }
}

/** The tenders already beside a sale, as the settlement rule reads them. */
function asTenders(payments: readonly SalePaymentRow[]): Tender[] {
  return payments.map((payment) => ({
    method: payment.method,
    status: payment.status,
    amount: pesewasFromDecimalString(payment.amount, 'an amount already recorded on this sale'),
  }));
}

/**
 * Whether a sale may still take a tender.
 *
 * A whitelist on `pending` rather than a blacklist on `voided`. `refunded` and
 * `partially_refunded` are members of `sale_status` that nothing in this build
 * ever writes, and a blacklist would quietly admit them the day a refund path
 * lands — taking money against a sale that has already given some back.
 *
 * 409 and not 400 for the same reason the shortfall is: the request is well
 * formed and the sale has moved on. Phase 9's queue reads the status to decide
 * whether to retry, and "you sent the wrong thing" would strand a payment that
 * simply arrived late.
 */
function refuseUnlessOpen(sale: SaleRow): void {
  if (sale.status === 'pending') return;
  throw new HttpError(
    409,
    sale.status === 'voided'
      ? 'That sale has been voided, so it cannot take a payment.'
      : 'That sale is already settled, so it cannot take another payment.',
    { code: sale.status === 'voided' ? 'sale_voided' : 'sale_not_open' }
  );
}

/**
 * Adds one tender to a sale that has already been recorded, and re-settles it.
 *
 * This is the path a customer who could not pay at the counter comes back
 * through, and the path a mobile money prompt that timed out is retried on. The
 * sale row is locked first because the settlement is read, decided from, and
 * written back: without the lock a webhook confirming a charge and an operator
 * taking cash for the same sale interleave, and whichever lands second overwrites
 * a settlement the first had already completed.
 */
export async function addPayment(
  actor: Actor,
  saleId: string,
  input: SalePaymentInput,
  now: string
): Promise<SaleDetail> {
  return withTransaction(async (client) => {
    const sale = await lockSale(client, actor.pharmacyId, saleId);
    if (sale === null) throw notFound('sale');
    refuseUnlessOpen(sale);

    const totalPesewas = pesewasFromDecimalString(sale.total, 'the total on this sale');
    const existing = asTenders(await listSalePayments(client, saleId));
    const { tenders, settlement } = planTenders(totalPesewas, [input], existing);
    const tender = tenders[0];
    if (tender === undefined) {
      throw new Error('planTenders returned no tender for the one input it was given');
    }

    await insertSalePayment(client, {
      saleId,
      method: tender.method,
      status: tender.status,
      amount: tender.amount,
      reference: referenceFor(tender, sale.saleNumber),
      gatewayResponse: null,
      paidAt: tender.status === 'succeeded' ? now : null,
    });

    await updateSaleSettlement(client, saleId, {
      amountPaid: decimalStringFromPesewas(settlement.paidPesewas),
      changeGiven: decimalStringFromPesewas(settlement.changePesewas),
      status: settlement.status,
    });

    return detail(client, actor.pharmacyId, saleId);
  });
}

/** One tender, read for the caller that has to ask a gateway about it. */
export async function getPayment(
  pharmacyId: string,
  paymentId: string
): Promise<SalePaymentRow & { pharmacyId: string; saleStatus: SaleStatus }> {
  const payment = await findSalePayment(poolSql, pharmacyId, paymentId);
  if (payment === null) throw notFound('payment');
  return payment;
}

/**
 * What a gateway said about a charge. Never what a till said.
 *
 * `status` is a two-value union and not `SalePaymentStatus`: `pending` is the
 * state a tender is written in and `reversed` is what a void writes, so neither
 * is an outcome a gateway reports. Narrowing the type here is what stops a
 * webhook handler from being able to put a tender back in flight.
 *
 * There is no `reference` field, and the absence is the invariant rather than an
 * omission. A tender's reference is written once, when the tender is inserted, by
 * `referenceFor` — and it is the only thing a webhook has to find that tender
 * with. A gateway answer that could rewrite it would be able to orphan every
 * later webhook for the same charge, which is why `updateSalePaymentStatus` no
 * longer accepts one either. What the gateway said goes in `gatewayResponse`,
 * which is a `jsonb` column that exists to keep exactly that, verbatim.
 */
export interface PaymentOutcome {
  status: 'succeeded' | 'failed';
  /** Stored verbatim. What was believed, and the only evidence there is. */
  gatewayResponse?: unknown;
  paidAt?: string | null;
}

export interface PaymentOutcomeResult {
  detail: SaleDetail;
  /** False when the tender had already reached a terminal state, so nothing moved. */
  changed: boolean;
  /**
   * True when money arrived against a sale that has been voided.
   *
   * Not an error, and not something to fix by moving the tender back to
   * `succeeded`: the sale is cancelled and the receipt says so, but the wallet
   * was debited and somebody owes the customer a refund that this build has no
   * flow for. The honest answer is to leave both facts visible and let the route
   * log this one loudly, because a silent auto-transition would hide the refund.
   */
  arrivedAfterVoid: boolean;
}

/**
 * Records what the gateway said about a tender, and re-settles the sale.
 *
 * One function for both the `verify` route and the webhook, on purpose. The plan
 * is explicit that a charge response is never trusted on its own, and the way
 * that is enforced is by making the two callers able to disagree about nothing:
 * both hand a `PaymentOutcome` here and neither writes a status itself.
 *
 * ## The guard is the concurrency answer
 *
 * A webhook and a `verify` call for the same charge routinely arrive within a
 * second of each other, and both are entitled to think they are first.
 * `updateSalePaymentStatus` carries `and status = any(...)` in its `where`
 * clause, so the first through moves the tender and the second finds no row and
 * reports `changed: false` — which is the truth, not a failure. Read-then-write
 * here would let a delayed webhook re-mark a succeeded charge as pending and
 * silently un-settle a completed sale.
 *
 * ## A voided sale is still updated
 *
 * `updateSaleSettlement` is guarded `status <> 'voided'`, so the settlement
 * simply does not move — and the tender does, because what the gateway said
 * happened, happened. That is the case `arrivedAfterVoid` exists to surface.
 */
export async function applyPaymentOutcome(
  pharmacyId: string,
  paymentId: string,
  outcome: PaymentOutcome,
  now: string
): Promise<PaymentOutcomeResult> {
  return withTransaction(async (client) => {
    const payment = await findSalePayment(client, pharmacyId, paymentId);
    if (payment === null) throw notFound('payment');

    const sale = await lockSale(client, pharmacyId, payment.saleId);
    if (sale === null) throw notFound('sale');

    const updated = await updateSalePaymentStatus(client, paymentId, {
      status: outcome.status,
      ...(outcome.gatewayResponse === undefined ? {} : { gatewayResponse: outcome.gatewayResponse }),
      paidAt: outcome.status === 'succeeded' ? (outcome.paidAt ?? now) : null,
      allowedFrom: ['pending'],
    });

    if (updated === null) {
      return {
        detail: await detail(client, pharmacyId, sale.id),
        changed: false,
        arrivedAfterVoid: outcome.status === 'succeeded' && sale.status === 'voided',
      };
    }

    const totalPesewas = pesewasFromDecimalString(sale.total, 'the total on this sale');
    const settlement = settle(
      totalPesewas,
      asTenders(await listSalePayments(client, sale.id))
    );
    await updateSaleSettlement(client, sale.id, {
      amountPaid: decimalStringFromPesewas(settlement.paidPesewas),
      changeGiven: decimalStringFromPesewas(settlement.changePesewas),
      status: settlement.status,
    });

    return {
      detail: await detail(client, pharmacyId, sale.id),
      changed: true,
      arrivedAfterVoid: outcome.status === 'succeeded' && sale.status === 'voided',
    };
  });
}

/**
 * Cancels a sale and puts the stock back where it came from.
 *
 * ## To the batches, never to the product row
 *
 * The junction rows in `sale_item_batches` are the only record of which lot each
 * line drew from, and they are the only place a restore can go. Adding units to
 * `inventory.quantity` would be undone by `touch_inventory_after_batch_change`
 * the next time any batch of that product is written, because the derived columns
 * are recomputed from the batches and never written directly. Adding them to the
 * wrong batch would be worse than lost: the FEFO order would then hand the next
 * customer a lot that is not on the shelf, and a recall would trace units to a
 * lot they never left.
 *
 * ## The reason is mandatory
 *
 * `sales:void` is owner-only, and the reason is required at a length floor rather
 * than merely non-empty. A void is the one operation in this system that removes
 * a sale from the takings and puts stock back on the shelf at the same time, so
 * it is the one operation that can hide both a theft and a mistake — and "x", or
 * a single space, distinguishes neither.
 */
export async function voidSale(
  actor: Actor,
  saleId: string,
  input: { reason: unknown },
  now: string
): Promise<SaleDetail> {
  const reason = readReason(input.reason, 'A reason for the void', SALE_LIMITS.voidReason);

  return withTransaction(async (client) => {
    const sale = await lockSale(client, actor.pharmacyId, saleId);
    if (sale === null) throw notFound('sale');
    if (sale.status === 'voided') {
      throw new HttpError(409, 'That sale has already been voided.', {
        code: 'sale_already_voided',
      });
    }

    // Written first, and its own guard is what makes a double void impossible even
    // if the read above is stale: two owners clicking void at the same instant both
    // pass the check, and only one of them gets a row back. Restoring the same
    // stock twice is the failure this prevents, and it is a failure no report ever
    // shows — the drawer is simply heavier than the ledger thinks.
    const voided = await markSaleVoided(client, saleId, { reason, voidedAt: now });
    if (voided === null) {
      throw new HttpError(409, 'That sale has already been voided.', {
        code: 'sale_already_voided',
      });
    }

    const drawn = await listSaleItemBatches(client, saleId);

    // Every product this sale touched, locked in sorted order. The same discipline
    // `createSale` uses, because a void and a sale running at the same counter are
    // the ordinary case and not the rare one: two transactions holding product
    // locks in opposite orders deadlock, and the answer Postgres gives is a 500
    // after `deadlock_timeout` that reads like an outage.
    const holdings = new Map<string, Map<string, BatchRow>>();
    for (const inventoryId of [...new Set(drawn.map((row) => row.inventoryId))].sort()) {
      if ((await lockProduct(client, actor.pharmacyId, inventoryId)) === null) {
        // The sale drew from a product that is not there. `inventory` cascades to
        // `sale_items`, so this cannot happen through a delete; it means the row
        // was moved between pharmacies, which this build has no path for.
        throw new Error(`sale ${saleId} drew from product ${inventoryId}, which is not there`);
      }
      const batches = new Map<string, BatchRow>();
      for (const batch of await listBatchesForProduct(client, actor.pharmacyId, inventoryId)) {
        batches.set(batch.id, batch);
      }
      holdings.set(inventoryId, batches);
    }

    // What each batch is left at, accumulated across lines. Two lines of one basket
    // can draw from the same lot, and the second restore has to start from the
    // first rather than from what the database said before either.
    const restored = new Map<string, number>();

    for (const row of drawn) {
      const batch = holdings.get(row.inventoryId)?.get(row.batchId);
      if (batch === undefined) {
        throw new Error(`sale ${saleId} drew from batch ${row.batchId}, which is not there`);
      }
      const quantityAfter = (restored.get(row.batchId) ?? batch.quantity) + row.quantity;
      restored.set(row.batchId, quantityAfter);

      await insertMovement(client, {
        pharmacyId: actor.pharmacyId,
        inventoryId: row.inventoryId,
        batchId: row.batchId,
        // Tied to the sale, so the ledger answers "what did voiding this sale do"
        // without anyone having to match timestamps.
        saleId,
        movementType: 'void_restore',
        quantityChange: row.quantity,
        quantityAfter,
        reason,
        note: `Lot ${row.lotNumber}`,
        performedBy: actor.userId,
      });
    }

    for (const [batchId, quantity] of restored) {
      await setBatchQuantity(client, batchId, quantity);
    }

    // Every tender is handed back. `failed` ones are left alone: nothing arrived,
    // so there is nothing to reverse, and marking a declined charge `reversed`
    // would say money went back that never came.
    //
    // A `pending` mobile money tender is reversed too, and that is a real hazard
    // rather than a tidy one: the charge may still be in flight at the gateway and
    // reversing it here does not stop a wallet being debited. What happens next is
    // the point of `applyPaymentOutcome` — the webhook arrives, finds the tender no
    // longer `pending`, changes nothing, and reports `arrivedAfterVoid` so the route
    // can log that a refund is owed. Nothing is silently un-reversed.
    for (const payment of await listSalePayments(client, saleId)) {
      if (payment.status === 'failed' || payment.status === 'reversed') continue;
      await updateSalePaymentStatus(client, payment.id, {
        status: 'reversed',
        allowedFrom: ['pending', 'succeeded'],
      });
    }

    return detail(client, actor.pharmacyId, saleId);
  });
}

// ---------------------------------------------------------------------------
// Till support. All read-only, all cheap, and none of them able to block a sale.
// ---------------------------------------------------------------------------

/**
 * One product as the till's grid needs it.
 *
 * `baseUnitPrice` is the stored price and is named for what it is rather than
 * called `unitPrice`, because the whole reason `shared/src/selling-price.ts`
 * exists is that "unit price" does not say which unit. The grid converts it with
 * `sellingUnitPricePesewas` from the shared package — the same function the
 * server calls — so the rule has one home and a tile cannot show a price the
 * basket then disagrees with.
 *
 * Deliberately not converted here: sending a converted figure would mean the
 * server doing arithmetic the frontend has to redo anyway the moment the
 * operator switches a line from packs to singles, and two conversions is two
 * chances for them to differ.
 */
export interface TillProduct {
  id: string;
  name: string;
  code: string;
  genericName: string | null;
  category: string | null;
  manufacturer: string | null;
  shelfLocation: string | null;
  barcode: string | null;
  packSize: number;
  defaultSellUnit: SellUnit;
  /** Decimal string, per base unit. Convert with `sellingUnitPricePesewas`. */
  baseUnitPrice: string;
  vatTreatment: VatTreatment;
  requiresPrescription: boolean;
  /** Derived. Physical count, expired stock included. Not what may be sold. */
  quantity: number;
  batchNumber: string | null;
  expiryDate: string | null;
  /**
   * Selling units at `defaultSellUnit` that may actually be handed over: expired
   * lots excluded, and floored to whole packs. This is the figure the grid shows
   * and the in-stock filter uses.
   */
  available: number;
}

/**
 * The catalogue the till loads before it can sell anything.
 *
 * Two queries for the whole grid rather than one per product. The grid is the
 * first thing a till loads and a hundred products at a query each is a hundred
 * round trips before an operator can ring up a customer — on the connection that
 * is most likely to be a slow one, because the till is the part of this system
 * running on a shop's own internet.
 *
 * The in-stock filter is the frontend's, over `available`. A community pharmacy
 * carries a few hundred products, the whole catalogue is one page, and filtering
 * server-side against a paginated list is how a grid ends up showing three items
 * on a page of fifty.
 */
export async function tillProducts(
  pharmacyId: string,
  filters: ProductFilters,
  today: string
): Promise<{ products: TillProduct[] }> {
  const [products, holding] = await Promise.all([
    listProducts(poolSql, pharmacyId, filters),
    listBatchesHoldingStock(poolSql, pharmacyId),
  ]);

  // `listBatchesHoldingStock` orders by product and then FEFO, so each slice is
  // already in the order an allocation would want.
  const byProduct = new Map<string, BatchRow[]>();
  for (const batch of holding) {
    const list = byProduct.get(batch.inventoryId);
    if (list === undefined) byProduct.set(batch.inventoryId, [batch]);
    else list.push(batch);
  }

  return {
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      genericName: product.genericName,
      category: product.category,
      manufacturer: product.manufacturer,
      shelfLocation: product.shelfLocation,
      barcode: product.barcode,
      packSize: product.packSize,
      defaultSellUnit: product.defaultSellUnit,
      baseUnitPrice: product.unitPrice,
      vatTreatment: product.vatTreatment,
      requiresPrescription: product.requiresPrescription,
      quantity: product.quantity,
      batchNumber: product.batchNumber,
      expiryDate: product.expiryDate,
      available: availableInSellUnits(
        byProduct.get(product.id) ?? [],
        product.defaultSellUnit,
        product.packSize,
        today
      ),
    })),
  };
}

export async function tillCategories(pharmacyId: string): Promise<{ categories: string[] }> {
  return { categories: await listCategories(poolSql, pharmacyId) };
}

export interface Approver {
  id: string;
  fullName: string;
  role: UserRole;
}

/**
 * Who the till may name as an approver, so the picker only offers people who can
 * actually approve.
 *
 * A list that offered everyone and then refused the ones without the permission
 * would be a control that works and a counter that stalls: the operator picks a
 * colleague, the sale is refused, and the customer is standing there while a
 * second name is tried. Filtering here is the same rule the write path enforces,
 * applied before the basket is rung rather than after.
 */
export async function listApprovers(pharmacyId: string): Promise<{ approvers: Approver[] }> {
  const staff = await listStaff(pharmacyId);
  return {
    approvers: staff
      .filter((user) => user.isActive && can(user.role, 'prescriptions:approve'))
      .map((user) => ({ id: user.id, fullName: user.fullName, role: user.role })),
  };
}

export interface PaymentConfig {
  publicKey: string;
  configured: boolean;
  /** `live`, `test` or `unconfigured`. Stated rather than implied. */
  mode: GatewayMode;
  methods: SalePaymentMethod[];
  currency: 'GHS';
}

/**
 * What the till needs to take a mobile money payment, and nothing more.
 *
 * Authenticated, unlike `/health/config` which answers the same question with the
 * key left out: the public key is what Paystack's own script is initialised with,
 * so it is not a secret — but publishing it to anyone who can reach the internet
 * invites charges against A&B's account from a page nobody controls.
 *
 * `mode` is stated because a till running against test keys must not look
 * identical to one taking real money. `configured` is false when the two keys
 * disagree on their mode, and then the till records mobile money manually and
 * says so rather than handing a customer a prompt that cannot complete.
 */
export function paymentConfig(): PaymentConfig {
  return {
    publicKey: config.paystack.publicKey,
    configured: config.paystack.configured,
    mode: config.paystack.mode,
    methods: [...SALE_PAYMENT_METHODS],
    currency: 'GHS',
  };
}
