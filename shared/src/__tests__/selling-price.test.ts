import { isTaxError } from '../errors';
import { MAX_AMOUNT_PESEWAS } from '../money';
import {
  MAX_BASE_UNITS_PER_LINE,
  baseUnitsSold,
  sellingUnitPricePesewas,
} from '../selling-price';
import type { SellUnit } from '../selling-price';

/**
 * The selling-unit rule.
 *
 * The property that matters is not that a pack costs more than a tablet — that is
 * obvious — but that the *price* conversion and the *quantity* conversion read
 * `pack_size` the same way. They are two functions, and if one multiplied by ten
 * where the other divided, every pack sale would still produce a receipt whose
 * lines added to its total, and would still take the wrong number of tablets off
 * the shelf. Nothing a cashier looks at would be wrong. So the sweep at the bottom
 * of this file checks the money against the stock rather than checking each
 * function against its own arithmetic.
 *
 * The figures are a real shape of sale in a community pharmacy: a strip of ten
 * paracetamol tablets, priced per tablet, sold either loose or as the strip.
 */

interface Failure {
  code: string;
  message: string;
  field: string | undefined;
}

/** Runs something expected to refuse, and reports what it refused with. */
function failureOf(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    if (isTaxError(error)) {
      return { code: error.code, message: error.message, field: error.field };
    }
    // A plain `Error` is also a refusal, and the exhaustiveness guards throw one.
    // Reporting it in the same shape keeps the assertions below readable instead of
    // needing a second helper for a second error type.
    if (error instanceof Error) {
      return { code: '(plain Error)', message: error.message, field: undefined };
    }
    throw error;
  }
  throw new Error('expected a refusal, and it returned a value instead');
}

/** GHS 0.55 per tablet — 55 pesewas. */
const TABLET_PESEWAS = 55;
/** A strip of ten. */
const STRIP = 10;

describe('sellingUnitPricePesewas', () => {
  it('leaves a single at the stored price, because the stored price is per base unit', () => {
    expect(
      sellingUnitPricePesewas({
        baseUnitPricePesewas: TABLET_PESEWAS,
        packSize: STRIP,
        sellUnit: 'single',
      })
    ).toBe(55);
  });

  it('multiplies a pack by the pack size — the conversion this module exists for', () => {
    // The strip is GHS 5.50, not GHS 0.55 and not GHS 55.00. Both of those wrong
    // answers are one character away from this one, and both look plausible on a
    // receipt until somebody counts the money at the end of the day.
    expect(
      sellingUnitPricePesewas({
        baseUnitPricePesewas: TABLET_PESEWAS,
        packSize: STRIP,
        sellUnit: 'pack',
      })
    ).toBe(550);
  });

  it('gives the same price for both units when the pack size is one', () => {
    // A bottle of syrup has no smaller selling unit, so `pack_size` is 1 and the
    // two branches must agree. If they did not, changing `default_sell_unit` on
    // such a product would change its price — which is the failure mode the
    // per-base-unit rule exists to prevent.
    const single = sellingUnitPricePesewas({
      baseUnitPricePesewas: 1_200,
      packSize: 1,
      sellUnit: 'single',
    });
    const pack = sellingUnitPricePesewas({
      baseUnitPricePesewas: 1_200,
      packSize: 1,
      sellUnit: 'pack',
    });
    expect(single).toBe(1_200);
    expect(pack).toBe(single);
  });

  it('never divides, so a pack price is always exact in whole pesewas', () => {
    // The reason `unit_price` can be `numeric(12, 2)` while `unit_cost` needs four
    // places. Cost is divided at receive time; price is only ever multiplied here.
    // A sweep over awkward pack sizes proves no rounding was introduced.
    for (const packSize of [2, 3, 7, 9, 10, 13, 100]) {
      for (const base of [1, 3, 7, 33, 55, 999]) {
        expect(
          sellingUnitPricePesewas({ baseUnitPricePesewas: base, packSize, sellUnit: 'pack' })
        ).toBe(base * packSize);
      }
    }
  });

  it('refuses a base price the engine cannot multiply by a quantity', () => {
    // `MAX_AMOUNT_PESEWAS` is what keeps `quantity × unitPrice` inside
    // `Number.MAX_SAFE_INTEGER` in `basket.ts`. Checking the *derived* price
    // against it is what extends that guarantee to a price nobody typed.
    expect(
      failureOf(() =>
        sellingUnitPricePesewas({
          baseUnitPricePesewas: MAX_AMOUNT_PESEWAS,
          packSize: 2,
          sellUnit: 'pack',
        })
      )
    ).toEqual({
      code: 'amount_out_of_range',
      message: 'the pack price is larger than this system can price',
      field: 'the pack price',
    });
  });

  it('refuses a base price that is already out of range, before deriving anything', () => {
    expect(
      failureOf(() =>
        sellingUnitPricePesewas({
          baseUnitPricePesewas: MAX_AMOUNT_PESEWAS + 1,
          packSize: 1,
          sellUnit: 'single',
        })
      ).code
    ).toBe('amount_out_of_range');
  });

  it('refuses a fractional or negative stored price', () => {
    expect(
      failureOf(() =>
        sellingUnitPricePesewas({
          baseUnitPricePesewas: 55.5,
          packSize: STRIP,
          sellUnit: 'pack',
        })
      ).message
    ).toBe('the unit price must be a whole number of pesewas');

    expect(
      failureOf(() =>
        sellingUnitPricePesewas({
          baseUnitPricePesewas: -55,
          packSize: STRIP,
          sellUnit: 'single',
        })
      ).message
    ).toBe('the unit price cannot be negative');
  });

  it('refuses a pack size of zero, which would make every pack free', () => {
    // The failure this guards is the quietest one available: a pack price of zero
    // and zero base units drawn, so the sale completes, charges nothing and moves
    // no stock. Reached in practice from a cached product row in the offline till,
    // which nothing has validated since it was written to IndexedDB.
    const failure = failureOf(() =>
      sellingUnitPricePesewas({
        baseUnitPricePesewas: TABLET_PESEWAS,
        packSize: 0,
        sellUnit: 'pack',
      })
    );
    expect(failure.code).toBe('(plain Error)');
    expect(failure.message).toContain('pack_size must be a whole number of 1 or more');
  });

  it('refuses a fractional pack size', () => {
    expect(
      failureOf(() =>
        sellingUnitPricePesewas({
          baseUnitPricePesewas: TABLET_PESEWAS,
          packSize: 2.5,
          sellUnit: 'pack',
        })
      ).message
    ).toContain('pack_size must be a whole number of 1 or more');
  });

  it('refuses a selling unit that is not in the schema', () => {
    const failure = failureOf(() =>
      sellingUnitPricePesewas({
        baseUnitPricePesewas: TABLET_PESEWAS,
        packSize: STRIP,
        sellUnit: 'crate' as unknown as SellUnit,
      })
    );
    expect(failure.message).toContain('unknown sell unit');
    expect(failure.message).toContain('crate');
  });
});

describe('baseUnitsSold', () => {
  it('turns two strips of ten into the twenty tablets a recall has to report', () => {
    // `sale_items.quantity` is 2 and the junction rows sum to 20. `recallTrace`
    // reads through the junction, so the answer to "who has lot X" is twenty
    // tablets and not two strips of them.
    expect(baseUnitsSold({ quantity: 2, packSize: STRIP, sellUnit: 'pack' })).toBe(20);
  });

  it('passes a quantity of singles through unchanged', () => {
    expect(baseUnitsSold({ quantity: 7, packSize: STRIP, sellUnit: 'single' })).toBe(7);
  });

  it('refuses a quantity of zero, which is indistinguishable from a line that moved no stock', () => {
    const failure = failureOf(() =>
      baseUnitsSold({ quantity: 0, packSize: STRIP, sellUnit: 'pack' })
    );
    expect(failure.code).toBe('line_out_of_range');
    expect(failure.field).toBe('quantity');
    expect(failure.message).toContain('whole number of 1 or more');
  });

  it('refuses a negative quantity, which is stock arriving through the selling path', () => {
    expect(
      failureOf(() => baseUnitsSold({ quantity: -3, packSize: STRIP, sellUnit: 'single' })).code
    ).toBe('line_out_of_range');
  });

  it('refuses a fractional quantity', () => {
    expect(
      failureOf(() => baseUnitsSold({ quantity: 1.5, packSize: STRIP, sellUnit: 'single' })).code
    ).toBe('line_out_of_range');
  });

  it('accepts exactly the most base units a sale line can record', () => {
    expect(
      baseUnitsSold({ quantity: MAX_BASE_UNITS_PER_LINE, packSize: 1, sellUnit: 'single' })
    ).toBe(MAX_BASE_UNITS_PER_LINE);
  });

  it('refuses a line that would overflow the integer column it is written to', () => {
    // `sale_item_batches.quantity` is a Postgres `integer`. Past its ceiling the
    // insert fails with 22003 `numeric_field_overflow`, which reaches the till as a
    // bare 500 on a sale that should have been refused with something readable.
    const failure = failureOf(() =>
      baseUnitsSold({ quantity: MAX_BASE_UNITS_PER_LINE, packSize: 2, sellUnit: 'pack' })
    );
    expect(failure.code).toBe('line_out_of_range');
    expect(failure.message).toContain('more units than a sale can record');
  });

  it('refuses a pack size of zero here too, so the two functions cannot disagree', () => {
    expect(
      failureOf(() => baseUnitsSold({ quantity: 2, packSize: 0, sellUnit: 'pack' })).message
    ).toContain('pack_size must be a whole number of 1 or more');
  });

  it('refuses a selling unit that is not in the schema', () => {
    expect(
      failureOf(() =>
        baseUnitsSold({ quantity: 2, packSize: STRIP, sellUnit: 'crate' as unknown as SellUnit })
      ).message
    ).toContain('unknown sell unit');
  });
});

describe('the price and the stock agree about what a pack is', () => {
  it('takes money equal to the base units times the base price, for any shape of line', () => {
    // The invariant the two functions have to share. `quantity × selling unit price`
    // is what the customer pays; `base units × base price` is what the shelf gave
    // up, valued the way it was priced. Those are the same figure only if both
    // functions read `pack_size` in the same direction. A deterministic sweep
    // rather than a handful of examples, because the case that would break is an
    // awkward one — an odd pack size, a price of one pesewa — and not the round
    // numbers a hand-written test reaches for.
    let state = 20_260_904;
    const next = (bound: number): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state % bound;
    };

    for (let iteration = 0; iteration < 4_000; iteration += 1) {
      const packSize = 1 + next(60);
      const quantity = 1 + next(40);
      const baseUnitPricePesewas = next(20_000);
      const sellUnit: SellUnit = next(2) === 0 ? 'single' : 'pack';

      const unitPrice = sellingUnitPricePesewas({
        baseUnitPricePesewas,
        packSize,
        sellUnit,
      });
      const units = baseUnitsSold({ quantity, packSize, sellUnit });

      const charged = quantity * unitPrice;
      const valued = units * baseUnitPricePesewas;

      if (charged !== valued) {
        // Reproducible from the message alone: a sweep that finds a defect has to
        // name the inputs that produced it, or the red test cannot be run twice.
        throw new Error(
          `price and stock disagree for ${String(quantity)} × ${sellUnit} of pack_size ` +
            `${String(packSize)} at ${String(baseUnitPricePesewas)} pesewas per base unit: ` +
            `charged ${String(charged)}, valued ${String(valued)}`
        );
      }
    }
  });
});
