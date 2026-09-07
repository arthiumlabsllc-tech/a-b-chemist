/**
 * The public surface of the shared package.
 *
 * One export point, so what the API and the offline till are allowed to reach is
 * a list somebody can read. Anything not re-exported here is internal, and a
 * consumer that imports it by path is a consumer that will break when the file
 * moves.
 *
 * Everything exported is pure: no I/O, no clock, no environment, no module state
 * that survives a call. `tsconfig.build.json` enforces most of that by giving the
 * compiler no declaration for `process`, `Buffer`, `require` or `console`.
 */

export { TAX_ERROR_CODES, TaxError, isTaxError } from './errors';
export type { TaxErrorCode } from './errors';

export {
  MAX_AMOUNT_PESEWAS,
  MAX_TOTAL_PESEWAS,
  PESEWAS_PER_CEDI,
  RATE_SCALE,
  applyRate,
  assertAmount,
  assertPesewas,
  assertRate,
  assertTotal,
  decimalStringFromPesewas,
  floorDiv,
  parseRate,
  pesewasFromDecimalString,
  rateDecimalString,
  rateLabel,
  roundHalfUp,
} from './money';

export {
  VAT_TREATMENTS,
  assertTreatment,
  taxFromInclusiveGross,
  taxOnExclusiveBase,
  taxOnLine,
  taxSettings,
} from './tax';
export type { TaxSettings, TaxSplit, VatTreatment } from './tax';

export { apportionDiscount } from './discount';
export type { ApportionedDiscount } from './discount';

export {
  MAX_BASE_UNITS_PER_LINE,
  SELL_UNITS,
  baseUnitsSold,
  sellingUnitPricePesewas,
} from './selling-price';
export type { BaseUnitsSoldInput, SellUnit, SellingUnitPriceInput } from './selling-price';

export { MAX_LINE_QUANTITY, priceBasket } from './basket';
export type { BasketInput, BasketLineInput, PricedBasket, PricedLine } from './basket';

export {
  ACT_1151_AS_STORED,
  ACT_1151_EXCLUSIVE,
  ACT_1151_INCLUSIVE,
  GRA_EXAMPLE,
  GRA_INSTRUMENT,
  GRA_IN_FORCE_FROM,
  GRA_PRE_REFORM,
  GRA_RATES,
  GRA_RETRIEVED,
  GRA_SOURCE,
  NOT_VAT_REGISTERED,
} from './fixtures/gra-worked-example';
export type { GraIllustration } from './fixtures/gra-worked-example';

export { TAX_PARITY_VECTORS, PARITY_VECTOR_SOURCE } from './fixtures/tax-parity';
export type { TaxParityVector, VectorProvenance } from './fixtures/tax-parity';
