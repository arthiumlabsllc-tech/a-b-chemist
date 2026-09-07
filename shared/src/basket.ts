import { apportionDiscount } from './discount';
import { TaxError } from './errors';
import { assertAmount, assertTotal } from './money';
import {
  type TaxSettings,
  type TaxSplit,
  type VatTreatment,
  assertTreatment,
  taxOnLine,
} from './tax';

/**
 * Pricing a whole basket.
 *
 * The output field names are the `sales` and `sale_items` column names, and that
 * is deliberate. Phase 6's write path has to put these numbers into those columns
 * in one transaction, and a mapping between two vocabularies is a mapping that can
 * be wrong in a way that still typechecks — `lineTotal` into `line_gross` is a
 * plausible line of code and a receipt that overcharges by the tax. Naming the
 * engine's output after its destination makes a mismatch something a reader sees.
 *
 * Tax is computed **per line and summed**, never on the basket total. That is not
 * a refinement: a basket holding an exempt medicine and a standard-rated bottle of
 * shampoo has no single taxable value, and computing one would charge VAT on the
 * medicine or lose it on the shampoo. It also means a rounding on one line cannot
 * be cancelled by an opposite rounding on another, so the total the customer pays
 * is the sum of figures each of which is defensible on its own.
 */

/** One line as the till knows it. */
export interface BasketLineInput {
  /**
   * The caller's own key for the line, echoed back so results can be matched to
   * inputs. Must be unique within a basket: two lines answering to one key is a
   * mapping that silently picks one of them.
   */
  id: string;
  /**
   * How many selling units. Not base units — see `unitPricePesewas`.
   *
   * Refused below one, matching `sale_items.quantity integer check (quantity > 0)`.
   */
  quantity: number;
  /**
   * The price of one **selling unit**, in pesewas.
   *
   * Per selling unit and not per base unit, which is what makes `pack_size` a
   * stock concern rather than a pricing one. A box of 100 tablets sold as a pack
   * has one `unit_price` for the box; the pack size decides how many base units
   * come off the batch, and `utils/fefo.ts` in the backend handles that. Keeping
   * the two apart means this package never needs to know what a pack is, and the
   * offline pricer in Phase 9 stays able to price a sale it cannot yet deduct
   * stock for.
   */
  unitPricePesewas: number;
  /**
   * How this line is treated for VAT: `standard`, `exempt` or `zero_rated`.
   *
   * Named to match `PricedLine.vatTreatment` and the `sale_items.vat_treatment`
   * column, so that one concept has one name across a request, a response and a
   * row. It was `treatment` while the output was `vatTreatment`, and the
   * asymmetry costs a caller nothing at compile time and everything at the till:
   * a misspelt field arrives as `undefined`, which `assertTreatment` then reports
   * as a wrong *value* — "enter one of standard, exempt, zero_rated" — to someone
   * who passed exactly that.
   */
  vatTreatment: VatTreatment;
}

/** One priced line, in `sale_items`' vocabulary. */
export interface PricedLine {
  id: string;
  quantity: number;
  unitPricePesewas: number;
  /** `quantity × unitPrice`, before any discount. `sale_items.line_gross`. */
  lineGross: number;
  /** This line's share of the basket discount. `sale_items.line_discount`. */
  lineDiscount: number;
  /** The value the three charges were computed on. `sale_items.taxable_base`. */
  taxableBase: number;
  vatAmount: number;
  nhilAmount: number;
  getfundAmount: number;
  /**
   * What the customer pays for this line. `sale_items.line_total`.
   *
   * Inclusive pricing: `lineGross − lineDiscount`, because the shelf price already
   * carried the tax and the split above was extracted from it.
   * Exclusive pricing: that plus the tax, because the tax is added at the till.
   */
  lineTotal: number;
  vatTreatment: VatTreatment;
  inputTaxCreditable: boolean;
}

/** A priced basket, in `sales`' vocabulary. */
export interface PricedBasket {
  lines: readonly PricedLine[];
  /** Σ `lineGross`. `sales.subtotal`. */
  subtotal: number;
  /** `sales.discount`. Equals the discount asked for, exactly. */
  discount: number;
  /**
   * `sales.discount_reason`, or null when there was no discount.
   *
   * Mandatory whenever a discount exists, which the schema comment states as
   * policy and this module enforces: an unexplained discount is the shape of a
   * leak, and it is the kind of rule that has to be enforced where it cannot be
   * bypassed. The offline till in Phase 9 prices a sale with no server in reach,
   * so a check that lived only in the API would be a check that does not exist for
   * every sale taken during an outage.
   */
  discountReason: string | null;
  /** Σ line VAT. `sales.vat_amount`. */
  vatAmount: number;
  nhilAmount: number;
  getfundAmount: number;
  /** `sales.tax_total`. Always the sum of the three above. */
  taxTotal: number;
  /** Σ line `taxableBase`. */
  taxableBase: number;
  /** Σ `lineTotal` — the amount due. `sales.total`. */
  total: number;
  /**
   * The four values `sales` snapshots beside the money, returned so the caller can
   * write them without reaching back into its own input.
   *
   * A receipt shows the tax actually charged. Snapshotting the rates next to the
   * amounts is what makes that true six months later, when the settings row has
   * moved on and the only record of what was charged is the sale itself.
   */
  rates: {
    vatRate: number;
    nhilRate: number;
    getfundRate: number;
    taxInclusivePricing: boolean;
  };
  /** Pesewas of rounding remainder the apportionment had to place. */
  discountDrift: number;
  /** Which lines absorbed it, by index. Normally one: the largest. */
  discountDriftLines: readonly number[];
}

export interface BasketInput {
  settings: TaxSettings;
  lines: readonly BasketLineInput[];
  /** Defaults to no discount. */
  discountPesewas?: number;
  /** Required, and non-empty, whenever `discountPesewas` is above zero. */
  discountReason?: string | null;
}

/**
 * The most units one line may hold: one million.
 *
 * A commercial judgement and an arithmetic one, and the arithmetic is the binding
 * reason. `sale_items.quantity` is a Postgres `integer`, so the column would take
 * two billion; but `quantity * unitPricePesewas` has to stay inside
 * `Number.MAX_SAFE_INTEGER` or the product is a float that happens to look like an
 * integer, and the line total is then wrong by an amount nobody could predict.
 * At a million units the worst product is 1e6 × 9e7 = 9e13, two orders of
 * magnitude inside the bound, so every multiplication in this module is exact.
 *
 * A million units of one product on one line is not a transaction a community
 * pharmacy makes. The bound costs a real sale nothing and buys the guarantee that
 * the integer arithmetic this whole package rests on actually holds.
 */
export const MAX_LINE_QUANTITY = 1_000_000;

export function priceBasket(input: BasketInput): PricedBasket {
  const { settings } = input;
  const rawLines = input.lines;

  if (rawLines.length === 0) {
    throw new TaxError('basket_has_no_value', 'There is nothing in the basket');
  }

  const seen = new Set<string>();
  const lines = rawLines.map((line, index) => {
    const label = `line ${index + 1}`;
    if (typeof line.id !== 'string' || line.id.trim() === '') {
      throw new TaxError('line_out_of_range', `${label} has no identifier`, label);
    }
    if (seen.has(line.id)) {
      throw new TaxError('line_out_of_range', `${label} repeats the identifier of an earlier line`, label);
    }
    seen.add(line.id);

    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      // One message for both refusals, and it names both requirements: `1.5` is above
      // one and still wrong, so "must be at least one unit" would send an operator
      // looking at the size of a number that is not the problem.
      throw new TaxError(
        'line_out_of_range',
        `${label} must be a whole number of units, at least one`,
        label
      );
    }
    if (line.quantity > MAX_LINE_QUANTITY) {
      throw new TaxError(
        'line_out_of_range',
        `${label} cannot be more than ${MAX_LINE_QUANTITY} units`,
        label
      );
    }
    assertAmount(line.unitPricePesewas, `${label} unit price`);

    // Exact, because both factors were bounded above with that in mind.
    const gross = line.quantity * line.unitPricePesewas;
    assertAmount(gross, `${label} total`);

    return {
      id: line.id,
      quantity: line.quantity,
      unitPricePesewas: line.unitPricePesewas,
      lineGross: gross,
      // Runtime narrowing on top of the compile-time type. A caller in TypeScript
      // cannot pass anything but a `VatTreatment`; a caller reading a cached
      // catalogue out of IndexedDB, or a JSON body, can pass any string, and an
      // unrecognised treatment falling through to a default would price it as
      // exempt — silently, and in the direction that loses revenue.
      vatTreatment: assertTreatment(line.vatTreatment, `${label} VAT treatment`),
    };
  });

  const subtotal = assertTotal(
    lines.reduce((sum, line) => sum + line.lineGross, 0),
    'the basket subtotal'
  );

  const discount = input.discountPesewas ?? 0;
  const reason = normaliseReason(input.discountReason, discount);
  const { shares, drift, driftLines } = apportionDiscount(
    lines.map((line) => line.lineGross),
    discount
  );

  const priced: PricedLine[] = [];
  let vatAmount = 0;
  let nhilAmount = 0;
  let getfundAmount = 0;
  let taxableBase = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const share = shares[index];
    if (line === undefined || share === undefined) continue;

    const charged = line.lineGross - share;
    const split: TaxSplit = taxOnLine(charged, settings, line.vatTreatment);

    vatAmount += split.vat;
    nhilAmount += split.nhil;
    getfundAmount += split.getfund;
    taxableBase += split.taxableBase;

    // Frozen individually, not only as elements of a frozen array. `Object.freeze`
    // is shallow and `readonly PricedLine[]` says nothing about the elements, so
    // freezing the container alone would leave `basket.lines[0].lineTotal = 999`
    // both permitted and silent — and that is the one mutation that matters, because
    // `basket.total` is the sum of the line totals and the receipt would then
    // disagree with the basket it came from.
    priced.push(
      Object.freeze({
        id: line.id,
        quantity: line.quantity,
        unitPricePesewas: line.unitPricePesewas,
        lineGross: line.lineGross,
        lineDiscount: share,
        taxableBase: split.taxableBase,
        vatAmount: split.vat,
        nhilAmount: split.nhil,
        getfundAmount: split.getfund,
        lineTotal: settings.taxInclusivePricing ? charged : charged + split.taxTotal,
        vatTreatment: split.treatment,
        inputTaxCreditable: split.inputTaxCreditable,
      })
    );
  }

  const taxTotal = vatAmount + nhilAmount + getfundAmount;

  // The summed figures are checked with `assertTotal`, not `assertAmount`, and the
  // distinction is the two ceilings in `money.ts`. `assertAmount` guards values
  // about to be *multiplied*, where the product has to stay below 2^53; these are
  // only ever added and then written to a `numeric(12, 2)` column, so the bound
  // that applies to them is the one the column imposes. Using the tighter check
  // here would refuse a basket that is storable and arithmetically exact. The one
  // summed value that does get multiplied is the basket total inside
  // `apportionDiscount`, and that is checked there, next to the product.

  return Object.freeze({
    lines: Object.freeze(priced),
    subtotal,
    discount,
    discountReason: reason,
    vatAmount: assertTotal(vatAmount, 'the VAT'),
    nhilAmount: assertTotal(nhilAmount, 'the NHIL'),
    getfundAmount: assertTotal(getfundAmount, 'the GETFund levy'),
    taxTotal: assertTotal(taxTotal, 'the tax total'),
    taxableBase: assertTotal(taxableBase, 'the taxable base'),
    total: assertTotal(
      priced.reduce((sum, line) => sum + line.lineTotal, 0),
      'the basket total'
    ),
    rates: Object.freeze({
      vatRate: settings.vatRate,
      nhilRate: settings.nhilRate,
      getfundRate: settings.getfundRate,
      taxInclusivePricing: settings.taxInclusivePricing,
    }),
    discountDrift: drift,
    discountDriftLines: Object.freeze(driftLines),
  });
}

/**
 * The discount reason, or null when there is no discount.
 *
 * A reason is demanded only when money actually moved. Asking for one on a
 * zero discount would make the common case — no discount — into a form the till
 * operator has to satisfy, and a required field everybody fills with "-" teaches
 * everybody that required fields are noise.
 */
function normaliseReason(reason: string | null | undefined, discount: number): string | null {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (discount === 0) return null;
  if (text === '') {
    throw new TaxError(
      'discount_reason_required',
      'A discount needs a reason recorded against it',
      'discountReason'
    );
  }
  return text;
}
