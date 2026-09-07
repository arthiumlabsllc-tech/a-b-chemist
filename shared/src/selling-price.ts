/**
 * The selling-unit rule: how a pack becomes a price and a quantity of stock.
 *
 * A pure module, like everything else in this package. No database, no clock, no
 * HTTP.
 *
 * ## Why this file exists
 *
 * `inventory` holds **one** price column and the till sells in **two** units. A
 * strip of ten can be sold per tablet or per strip (BRIEF §4.3), so every price
 * the till shows, every total the engine prices and every quantity the allocator
 * draws is derived from a stored figure that does not say which of the two it
 * is. Get that wrong and a strip of ten sells for a tenth of its price, or for
 * ten times it — silently, on every pack sale, with the arithmetic all internally
 * consistent so nothing else looks broken.
 *
 * The same question is asked by the till's product grid, by the write-free quote
 * endpoint, by the sale write path and by the offline pricer in Phase 9. Answered
 * in four places the four drift, and the drift is invisible: an offline sale
 * priced one way and replayed to a server pricing it the other way records two
 * different amounts for one basket. Answered here they cannot. That is the same
 * argument `utils/fefo.ts` makes about the expiry rule, and it is why this lives
 * in the shared package rather than in the backend service that happens to need
 * it first.
 *
 * ## The rule, and why it runs in this direction
 *
 * **`inventory.unit_price` is the price of one base unit** — one tablet, one
 * sachet, one millilitre. `sale_items.unit_price` is the price of one **selling
 * unit**, which is the base price times `pack_size` when the line sells packs and
 * the base price unchanged when it sells singles.
 *
 * That is an inference: neither the schema nor the brief states it, and it is
 * recorded here with its reasoning so that it can be argued with rather than
 * quietly re-decided by whoever edits this next.
 *
 * The arithmetic direction is the evidence. `inventory_batches.unit_cost` is
 * `numeric(12, 4)` and `inventory.unit_price` is `numeric(12, 2)`. Cost gets four
 * decimal places because it is arrived at by **division** — a box total divided by
 * the units in it — and two places would not hold the answer. Price gets two
 * because it is only ever **multiplied**, and multiplication of whole pesewas is
 * exact. So the conversion in this file is a multiplication and never a division,
 * which is the property that makes two decimal places sufficient in the first
 * place.
 *
 * The alternative — `unit_price` meaning "the price of one default selling unit" —
 * has no answer at all for a line that overrides `default_sell_unit`, which is the
 * feature the brief asks for by name. It would need the same `pack_size`
 * conversion, in the dividing direction, and it would mean that editing
 * `default_sell_unit` from `single` to `pack` silently multiplied that product's
 * price by ten. Nothing in the schema would object, because nothing in the schema
 * would know.
 *
 * `sell_unit`'s own comment in `database/init.sql` states the stock half of the
 * same rule: *"'pack' consumes pack_size base units per unit sold."* It describes
 * a sale line as counting units **against a batch**, which is why `baseUnitsSold`
 * belongs beside the price conversion rather than in the allocator: `allocate()`
 * takes base units and returns base units, and something has to produce them.
 */

import { TaxError } from './errors';
import { assertAmount } from './money';

/**
 * `sell_unit`. Mirrored here rather than in the backend, for the reason
 * `VAT_TREATMENTS` is: this package needs the values to do arithmetic on them, so
 * a second list in `backend/src/utils/schema-enums.ts` would be two lists that
 * have to agree. That file re-exports this one, and `schema-enums.test.ts` still
 * compares it against the `CREATE TYPE` in `database/init.sql`.
 */
export const SELL_UNITS = ['single', 'pack'] as const;

export type SellUnit = (typeof SELL_UNITS)[number];

/**
 * The most base units one sale line may move.
 *
 * Not a commercial judgement — a schema one. `sale_item_batches.quantity` and
 * `stock_movements.quantity_change` are both Postgres `integer`, so a line asking
 * for more than this overflows the column and fails with 22003
 * `numeric_field_overflow`, which reaches the till as a bare 500 on a sale that
 * should have been refused with a readable message.
 *
 * Reachable without being absurd: `MAX_LINE_QUANTITY` allows a million selling
 * units and `pack_size` allows a hundred thousand, so the product is bounded only
 * by this. The allocator would report a shortfall for any quantity no batch holds,
 * but a shortfall is only the right answer when the number fits the column it is
 * about to be written to.
 */
export const MAX_BASE_UNITS_PER_LINE = 2_147_483_647;

export interface SellingUnitPriceInput {
  /**
   * `inventory.unit_price`, in pesewas. Per base unit — see the module header.
   */
  baseUnitPricePesewas: number;
  /** `inventory.pack_size`. Base units in one pack. */
  packSize: number;
  /** The unit this line sells in. */
  sellUnit: SellUnit;
}

/**
 * The price of one selling unit, in pesewas — the figure that goes into
 * `BasketLineInput.unitPricePesewas` and is stored as `sale_items.unit_price`.
 *
 * Throws `TaxError` with `amount_out_of_range` when either the stored price or
 * the derived one is outside what the engine can multiply. Reusing the engine's
 * own error type is deliberate: the API already maps `TaxError` to a 400 with the
 * message and field intact, so a price too large to sell becomes a validation
 * response rather than an unhandled throw, with no new mapping to keep in step.
 *
 * The ceiling matters more than it looks. `MAX_AMOUNT_PESEWAS` is the bound that
 * keeps `quantity × unitPrice` inside `Number.MAX_SAFE_INTEGER` in `basket.ts`, so
 * checking the *result* against it is what preserves that guarantee: a pack price
 * derived here is multiplied by a quantity there, and if it could exceed the bound
 * the engine's arithmetic would be exact for every price it was given and inexact
 * for one it derived.
 */
export function sellingUnitPricePesewas(input: SellingUnitPriceInput): number {
  const { baseUnitPricePesewas, packSize, sellUnit } = input;

  assertAmount(baseUnitPricePesewas, 'the unit price');
  assertPackSize(packSize);

  if (sellUnit === 'single') {
    // Already per base unit, and a base unit is what a single sells.
    return baseUnitPricePesewas;
  }
  if (sellUnit === 'pack') {
    const packPrice = baseUnitPricePesewas * packSize;
    assertAmount(packPrice, 'the pack price');
    return packPrice;
  }

  // Unreachable while `SellUnit` has two members, and that is the point: the
  // parameter is typed, so a value that is not one of them is a caller bug rather
  // than input. Adding a third selling unit to the enum without handling it here
  // makes `never` a type error at this line instead of a price that quietly falls
  // through to the per-base-unit answer.
  const unhandled: never = sellUnit;
  throw new Error(`sellingUnitPricePesewas() was given an unknown sell unit: ${String(unhandled)}`);
}

export interface BaseUnitsSoldInput {
  /** How many selling units the line is for. `sale_items.quantity`. */
  quantity: number;
  packSize: number;
  sellUnit: SellUnit;
}

/**
 * How many base units a line takes off the batches — the figure `allocate()`
 * wants and `sale_item_batches.quantity` stores.
 *
 * The mirror of `sellingUnitPricePesewas`, and it must stay one: a line of two
 * strips of ten has `quantity` 2, a unit price for a strip, and twenty base units
 * leaving the drawer. `recallTrace` reads the twenty through the junction table,
 * so a recall reports twenty tablets of a lot and not two strips of it. Price and
 * quantity derived from different readings of `pack_size` would still balance on
 * the receipt and still be wrong on the shelf.
 */
export function baseUnitsSold(input: BaseUnitsSoldInput): number {
  const { quantity, packSize, sellUnit } = input;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    // The same refusal `allocate()` makes and `sale_items.quantity > 0` enforces.
    // Thrown rather than answered with zero: zero base units sold is
    // indistinguishable from a line that never touched stock.
    throw new TaxError(
      'line_out_of_range',
      `A quantity must be a whole number of 1 or more, not ${String(quantity)}`,
      'quantity'
    );
  }
  assertPackSize(packSize);

  // An explicit chain rather than a ternary, so that a third selling unit added to
  // the enum has nowhere to fall through to. `quantity * (sellUnit === 'pack' ?
  // packSize : 1)` reads the same today and would charge a crate as a single.
  let units: number;
  if (sellUnit === 'single') {
    units = quantity;
  } else if (sellUnit === 'pack') {
    units = quantity * packSize;
  } else {
    const unhandled: never = sellUnit;
    throw new Error(`baseUnitsSold() was given an unknown sell unit: ${String(unhandled)}`);
  }

  if (units > MAX_BASE_UNITS_PER_LINE) {
    throw new TaxError(
      'line_out_of_range',
      'That line moves more units than a sale can record. Reduce the quantity or sell singles.',
      'quantity'
    );
  }

  return units;
}

/**
 * `inventory.pack_size`: a positive whole number.
 *
 * Checked here and not only at the route, because this package is also loaded by
 * the offline till, where a cached product row is the input and nothing has
 * validated it since it was written to IndexedDB. `pack_size` of zero would make
 * every pack free and take no stock — a sale that succeeds, charges nothing and
 * moves nothing.
 */
function assertPackSize(packSize: number): void {
  if (!Number.isInteger(packSize) || packSize <= 0) {
    throw new Error(
      `pack_size must be a whole number of 1 or more, got ${String(packSize)}`
    );
  }
}
