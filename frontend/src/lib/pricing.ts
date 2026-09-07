/**
 * The till's local pricing: a basket in, money out.
 *
 * ## What this module is for, and what it is not for
 *
 * `POST /sales` accepts `productId`, `quantity` and an optional `sellUnit` — and
 * no price at all. The server derives the money itself, from `inventory.unit_price`
 * and the pharmacy's tax settings row, at write time. So nothing computed here is
 * authoritative for anything.
 *
 * It is still not optional. A till that cannot show a total until it has asked the
 * server is a till that cannot be used, and the operator taps a product and needs
 * to see the price move. This module produces that figure immediately, on the
 * device, using the same arithmetic the server uses — because it calls the same
 * functions, from `a-and-b-chemist-shared`, rather than reimplementing them. That
 * package exists for exactly this: `POST /sales/quote`'s own comment says the
 * basket engine lives in shared "precisely so the frontend prices a basket locally
 * with the same arithmetic the server uses".
 *
 * The order at the counter is therefore: price locally on every keystroke, then
 * call `/quote` once before the payment modal opens, and show the server's figure.
 * When the two differ — because a price or a rate changed since the grid was
 * loaded — the server's is the one the customer is asked to pay, and the till says
 * so rather than silently swapping the number.
 *
 * ## The two conversions that are easy to get wrong
 *
 * **Pack price.** `TillProduct.baseUnitPrice` is per *base unit* — one tablet, one
 * sachet, one millilitre — and a line may sell packs. `sellingUnitPricePesewas`
 * does that multiplication and `baseUnitsSold` does the matching quantity
 * conversion, and the two must stay one reading of `pack_size` or a receipt
 * balances while a recall reports the wrong quantity. Neither is done by hand here.
 *
 * **Cedis and pesewas.** Every amount in the shared engine is a whole number of
 * pesewas; every amount in the API's JSON is a decimal string of cedis. The
 * boundary is crossed in exactly two functions — `parseCediInput` going in and
 * `moneyText` coming out — plus `basketToRequest`, which turns the integer
 * discount back into the decimal string the `numeric(12, 2)` column wants.
 * Crossing it anywhere else is how a GHS 5 discount becomes a GHS 500 one.
 */

import {
  baseUnitsSold,
  decimalStringFromPesewas,
  isTaxError,
  pesewasFromDecimalString,
  priceBasket,
  sellingUnitPricePesewas,
  taxSettings,
} from 'a-and-b-chemist-shared';
import type {
  BasketLineInput,
  PricedBasket,
  SellUnit,
  TaxSettings,
  TaxErrorCode,
  VatTreatment,
} from 'a-and-b-chemist-shared';

import type {
  CreateSaleBody,
  CreateSaleLine,
  CreateSalePayment,
  TaxSettingsView,
  TillProduct,
} from './api-types';

// ---------------------------------------------------------------------------
// The basket
// ---------------------------------------------------------------------------

/**
 * One line of an open basket.
 *
 * A **snapshot** rather than a reference to the catalogue entry. The pricing
 * fields are copied when the line is added, so a grid refresh cannot silently
 * re-price a basket somebody is halfway through ringing: the operator tapped a
 * tile that said GHS 12.00 and the basket still says GHS 12.00, and if the price
 * has moved the `/quote` before the payment modal is what reveals it, in words,
 * instead of the total changing under their finger.
 */
export interface BasketLine {
  /**
   * Identifies the line, not the product.
   *
   * The same product may legitimately be on two lines — a strip sold per tablet
   * and a strip sold per box — and `priceBasket` echoes `id` back on each
   * `PricedLine`, so keying by product would collapse the two and the receipt
   * would show one line the drawer did not ring.
   */
  lineId: string;
  productId: string;
  name: string;
  code: string;
  /** Selling units, not base units. `baseUnitsSold` converts when stock matters. */
  quantity: number;
  sellUnit: SellUnit;
  packSize: number;
  /** Decimal string, per base unit, as `TillProduct.baseUnitPrice` carried it. */
  baseUnitPrice: string;
  vatTreatment: VatTreatment;
  requiresPrescription: boolean;
}

/**
 * Starts a line from a catalogue entry, snapshotting the pricing fields.
 *
 * `sellUnit` defaults to the product's own, which is what a tap on the grid
 * means; the override is the "sell as pack / sell as single" control.
 */
export function basketLineFor(
  product: TillProduct,
  lineId: string,
  sellUnit?: SellUnit,
  quantity = 1
): BasketLine {
  return {
    lineId,
    productId: product.id,
    name: product.name,
    code: product.code,
    quantity,
    sellUnit: sellUnit ?? product.defaultSellUnit,
    packSize: product.packSize,
    baseUnitPrice: product.baseUnitPrice,
    vatTreatment: product.vatTreatment,
    requiresPrescription: product.requiresPrescription,
  };
}

/**
 * The price of one selling unit in pesewas, or null when the stored price cannot
 * be used.
 *
 * Total rather than throwing, because it is called from the product grid: one
 * product with a corrupt `unit_price` must not take the whole catalogue down with
 * it. Null renders the tile as unpriceable and refuses to add it, which is the
 * client-side half of the backend's `product_unpriceable` — and the wording is
 * deliberately the same shape, because in both cases the person at the counter
 * cannot fix it and the owner can.
 *
 * The pack size is checked here as well as the price, for the same reason and
 * because the engine will not do it quietly. `assertPackSize` throws a plain
 * `Error`, on purpose: a `pack_size` of zero would make every pack free and take
 * no stock, which is a bug and deserves to be loud. Loud is right inside the
 * engine and wrong in a grid, where it would take every tile down with it.
 */
export function unitPricePesewas(
  baseUnitPrice: string,
  packSize: number,
  sellUnit: SellUnit
): number | null {
  if (!Number.isInteger(packSize) || packSize <= 0) {
    return null;
  }
  try {
    return sellingUnitPricePesewas({
      baseUnitPricePesewas: pesewasFromDecimalString(baseUnitPrice, 'unit price'),
      packSize,
      sellUnit,
    });
  } catch (error) {
    if (isTaxError(error)) {
      return null;
    }
    throw error;
  }
}

/** The selling-unit price of a basket line, or null. See `unitPricePesewas`. */
export function lineUnitPrice(line: BasketLine): number | null {
  return unitPricePesewas(line.baseUnitPrice, line.packSize, line.sellUnit);
}

/**
 * How many base units a line takes off the batches.
 *
 * Advisory only — the server allocates from real batches under FEFO and answers
 * with the lots it actually drew. Shown so the operator can see that two strips of
 * ten is twenty tablets leaving the drawer, which is the figure a recall later
 * reports.
 *
 * Not total, unlike `unitPricePesewas`: a line can only exist for a product the
 * grid could price, so a bad pack size here means the guard above was bypassed
 * rather than that the data is odd, and that should be loud.
 */
export function lineBaseUnits(line: BasketLine): number {
  return baseUnitsSold({
    quantity: line.quantity,
    packSize: line.packSize,
    sellUnit: line.sellUnit,
  });
}

/**
 * The most this product may be put on a line in this unit, or null when the till
 * cannot say.
 *
 * `TillProduct.available` counts selling units **at the product's own
 * `defaultSellUnit`**, and is floored to whole packs. Converting it to another
 * unit means multiplying by `pack_size` to reach base units and dividing again,
 * and the flooring makes that a lower bound: a pack-default product showing three
 * available might hold thirty-four loose tablets, so a cap derived from it would
 * refuse a sale the server would happily accept. A refused sale at a counter is
 * worse than an unbounded stepper, so the honest answer when the units differ is
 * "ask the server", and null is how this says it. `/quote` returns a real
 * `shortfall` per line and is what the payment modal goes on.
 */
export function maxQuantityFor(product: TillProduct, sellUnit: SellUnit): number | null {
  return sellUnit === product.defaultSellUnit ? product.available : null;
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

/**
 * The API's settings view, into the form the engine takes.
 *
 * **It reads `RateView.decimal`, and the reason is a unit trap worth writing
 * down.** `TaxSettings.vatRate` holds whole ten-thousandths, so `RateView.rate` —
 * also whole ten-thousandths — looks like the field to pass straight through. It
 * is not: `taxSettings()` is the parser, and its *input* is a decimal, which it
 * converts. Handing it `1500` is handing it a rate of 15,000%, and it refuses
 * with "between 0 and 1". Input and output units differ, which is the kind of
 * thing that reads correctly and fails on the first basket.
 *
 * `decimal` is also what the server prices with. `settingsFromRow` in
 * `backend/src/services/tax-settings.service.ts` passes the `numeric(5, 4)`
 * string `pg` returned, unchanged, so the till and the API take the same road
 * through `parseRate` and cannot round differently.
 *
 * The third spelling must not be used either: `label` is `'15%'`, and a
 * percentage is not a rate.
 *
 * `combinedRate` is not used either. It is the three added, for display, and
 * pricing with it would collapse a basket holding an exempt medicine and a
 * standard-rated shampoo into one taxable value, which is the single way this
 * module could be badly wrong.
 */
export function taxSettingsFromView(view: TaxSettingsView): TaxSettings {
  return taxSettings({
    taxInclusivePricing: view.taxInclusivePricing,
    vatRate: view.vat.decimal,
    nhilRate: view.nhil.decimal,
    getfundRate: view.getfund.decimal,
  });
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Why a basket could not be priced, in terms the UI can act on.
 *
 * `code` is the engine's, not one invented here, because the response differs by
 * code and not by message: `discount_reason_required` means focus the reason
 * field, `discount_exceeds_basket` means clamp the discount to the subtotal, and
 * `basket_has_no_value` means the basket is empty and there is nothing to say.
 * Branching on the message text instead would turn a copy edit in the shared
 * package into a till that stopped handling its own discount field.
 */
export interface TillPriceFailure {
  code: TaxErrorCode;
  message: string;
  /** The field the engine blamed, when it blamed one. */
  field?: string;
}

export type PricedTillBasket =
  | { ok: true; basket: PricedBasket }
  | { ok: false; failure: TillPriceFailure };

/** What the operator asked for on top of the lines themselves. */
export interface BasketAdjustment {
  /** Whole pesewas. Zero or omitted means no discount. */
  discountPesewas?: number;
  /** Required by the engine, and by policy, whenever a discount exists. */
  discountReason?: string | null;
}

/**
 * Prices a basket with the shared engine.
 *
 * Refusals come back as a value rather than a throw. The engine is right to
 * throw — it is a pure function and an impossible argument is a caller bug — but
 * at the till most of its refusals are ordinary typing: a discount bigger than the
 * basket, or a discount with no reason yet. Those are things the operator fixes in
 * the next keystroke, and an exception per keystroke is an error boundary per
 * keystroke. Anything that is *not* a `TaxError` is rethrown, because that really
 * is a bug and swallowing it would leave the till showing a stale total.
 */
export function priceTillBasket(
  lines: readonly BasketLine[],
  settings: TaxSettings,
  adjustment: BasketAdjustment = {}
): PricedTillBasket {
  try {
    const input: BasketLineInput[] = lines.map((line) => ({
      id: line.lineId,
      quantity: line.quantity,
      unitPricePesewas: sellingUnitPricePesewas({
        baseUnitPricePesewas: pesewasFromDecimalString(line.baseUnitPrice, 'unit price'),
        packSize: line.packSize,
        sellUnit: line.sellUnit,
      }),
      vatTreatment: line.vatTreatment,
    }));

    return {
      ok: true,
      basket: priceBasket({
        settings,
        lines: input,
        discountPesewas: adjustment.discountPesewas ?? 0,
        discountReason: adjustment.discountReason ?? null,
      }),
    };
  } catch (error) {
    if (!isTaxError(error)) {
      throw error;
    }
    const failure: TillPriceFailure = { code: error.code, message: error.message };
    return { ok: false, failure: error.field === undefined ? failure : { ...failure, field: error.field } };
  }
}

// ---------------------------------------------------------------------------
// Money, in and out
// ---------------------------------------------------------------------------

/**
 * Pesewas as a person reads them: `123450` is `'1,234.50'`.
 *
 * Not `Intl.NumberFormat`. A currency formatter's output depends on the ICU data
 * the runtime was built with, so the same receipt can print `GH₵1,234.50` on a
 * laptop and `GHS 1,234.50` on a container image built without full ICU — and a
 * document that differs by device is a document nobody can reconcile. Hand
 * grouping is the same on every device, which matters more than a locale-aware
 * thousands separator ever would.
 */
export function moneyText(pesewas: number): string {
  const decimal = decimalStringFromPesewas(pesewas);
  const separator = decimal.indexOf('.');
  const whole = separator === -1 ? decimal : decimal.slice(0, separator);
  const fraction = separator === -1 ? '' : decimal.slice(separator);
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction}`;
}

/**
 * Pesewas with the currency on it: `123450` is `'GHS 1,234.50'`.
 *
 * `GHS` rather than the `₵` sign. The cedi sign is what a Ghanaian price label
 * uses and it is the nicer glyph, but a thermal receipt printer's font page
 * commonly stops at ASCII, and a receipt is a statutory document: a total that
 * prints as a box is worse than one that spells the currency out.
 */
export function cediText(pesewas: number): string {
  return `GHS ${moneyText(pesewas)}`;
}

/**
 * What the operator typed, in pesewas, or null when it is not an amount.
 *
 * Null rather than a throw because this runs on every keystroke of the discount
 * field, and `'5.'`, `''` and `'-'` are all states a person passes through on the
 * way to `'5.50'`. Treating those as errors would flash a message while somebody
 * is still typing.
 *
 * Two decimal places at most, which is `pesewasFromDecimalString`'s rule and not
 * one invented here: a third place would be a fraction of a pesewa, and the engine
 * refuses it rather than rounding it into a margin figure nobody chose.
 */
export function parseCediInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  try {
    return pesewasFromDecimalString(trimmed, 'amount');
  } catch (error) {
    if (isTaxError(error)) {
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * A client-minted sale identifier.
 *
 * `crypto.randomUUID` only exists in a **secure context**, so it is missing on a
 * till served over plain HTTP to a LAN address — which is exactly how a pharmacy
 * counter on a router is set up. Falling back to `getRandomValues` is what keeps
 * the id available there, and the id is not a nicety: it is what makes a lost
 * response replayable instead of a second sale.
 */
export function newClientSaleId(): string {
  const webCrypto: Crypto | undefined =
    typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;

  if (webCrypto?.randomUUID !== undefined) {
    return webCrypto.randomUUID();
  }
  if (webCrypto?.getRandomValues !== undefined) {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    // Version 4 and the RFC 4122 variant bits, set over the random bytes rather
    // than instead of them: the shape is what makes it recognisable in a log.
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Neither, so there is no randomness source at all. Refusing beats inventing an
  // id from `Math.random`, which is not cryptographic and would collide across
  // the two tills this pharmacy is likely to run.
  throw new Error('This browser offers no source of randomness, so a sale cannot be made safe to retry');
}

/** Everything a sale needs besides the lines, all of it decided by the caller. */
export interface SaleRequestOptions extends BasketAdjustment {
  /**
   * Required, and deliberately not minted here.
   *
   * The caller generates it once, before the first attempt, and must reuse the
   * same value on every retry — that is the entire mechanism. A function that
   * generated it internally would produce a fresh id per call, so the retry that
   * `clientSaleId` exists to make safe would be the one thing it could not make
   * safe, and the failure would be a duplicate sale rather than an error.
   */
  clientSaleId: string;
  /** May be empty: a customer who cannot pay yet leaves the sale pending. */
  payments?: CreateSalePayment[];
  patientId?: string;
  /** The user id of a pharmacist or the owner, from `GET /sales/approvers`. */
  approvedBy?: string;
}

/**
 * The basket as `POST /sales` wants it.
 *
 * No prices and no tax: the server derives both, so sending them would be sending
 * a suggestion it ignores. The discount *is* sent, because it is a decision rather
 * than a derivation, and it goes as a decimal string of cedis — the engine held it
 * as pesewas and `sales.discount` is `numeric(12, 2)`. That conversion is the one
 * place the two units meet on the way out.
 */
export function basketToRequest(
  lines: readonly BasketLine[],
  options: SaleRequestOptions
): CreateSaleBody {
  const saleLines: CreateSaleLine[] = lines.map((line) => ({
    productId: line.productId,
    quantity: line.quantity,
    sellUnit: line.sellUnit,
  }));

  const discountPesewas = options.discountPesewas ?? 0;
  const body: CreateSaleBody = { lines: saleLines, clientSaleId: options.clientSaleId };

  // Omitted entirely rather than sent as zero. A `discount` of `'0.00'` with no
  // reason is a row that reads as though something was given away, and the
  // absence of the field is the honest record of "nothing was".
  if (discountPesewas > 0) {
    body.discount = decimalStringFromPesewas(discountPesewas);
    body.discountReason = options.discountReason ?? null;
  }
  if (options.payments !== undefined) {
    body.payments = options.payments;
  }
  if (options.patientId !== undefined) {
    body.patientId = options.patientId;
  }
  if (options.approvedBy !== undefined) {
    body.approvedBy = options.approvedBy;
  }
  return body;
}
