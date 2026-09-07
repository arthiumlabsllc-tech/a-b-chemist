import {
  GRA_INSTRUMENT,
  GRA_IN_FORCE_FROM,
  GRA_RATES,
  GRA_RETRIEVED,
  GRA_SOURCE,
  RATE_SCALE,
  isTaxError,
  parseRate,
  rateDecimalString,
  rateLabel,
  taxSettings,
  type TaxSettings,
} from 'a-and-b-chemist-shared';
import {
  readTaxSettings,
  writeTaxSettings,
  type TaxSettingsRow,
} from '../repositories/tax-settings.repository';
import { HttpError } from '../utils/http';
import {
  faultFrom,
  TAX_RATE_FIELDS,
  validationErrorFromFaults,
  type TaxFault,
} from '../utils/tax-errors';

/**
 * Reading and changing what the pharmacy charges.
 *
 * Three functions, and the split is the point. `taxSettingsForPricing` is what a
 * sale prices with and returns the engine's own frozen object; `readTaxSettingsView`
 * is what a settings page shows and carries both spellings of every rate plus a
 * comparison against what GRA publishes; `changeTaxSettings` is the owner-only
 * write. A sale must never be priced from the view, because the view carries
 * strings for a human and a sale must carry integers for the engine.
 *
 * Nothing here is cached. One `select` of one row per sale is the cheapest thing
 * in the request, and a cache would be the only way this code could charge a tax
 * rate that is not the one in the database — which is the failure an owner cannot
 * detect from a receipt, because the receipt would show the cached rate too and
 * agree with itself.
 *
 * A change takes effect on the next sale and cannot be scheduled. There is no
 * effective-date column, so the row says what the pharmacy charges from the
 * moment it is written. Sales already taken are unaffected either way: each one
 * snapshotted the rates it used, which is why the receipt stays true after the
 * row moves on.
 */

/** One rate, in every spelling a consumer needs. */
export interface RateView {
  /** Whole ten-thousandths. What the engine prices with. */
  rate: number;
  /** `'15%'`. What a receipt names it as, which GRA requires it to do. */
  label: string;
  /** `'0.1500'`. What a form field shows and what the column stores. */
  decimal: string;
}

export interface TaxSettingsView {
  taxInclusivePricing: boolean;
  vat: RateView;
  nhil: RateView;
  getfund: RateView;
  /**
   * The three added, because that is what a customer experiences and what an
   * owner means by "what do we charge".
   *
   * `combinedLabel` is null when the sum passes 100%, which `rateLabel` refuses:
   * it asserts its argument is a rate the engine would apply, and a sum of three
   * rates is not one of those. Each rate is individually capped at 100% by the
   * column and by `parseRate`, so a sum of 300% is reachable through a legitimate
   * if absurd write. Degrading to no label is better than a 500 on the settings
   * page, and better than quietly printing a figure the engine would refuse to
   * charge.
   */
  combinedRate: number;
  combinedLabel: string | null;
  /**
   * Whether the three rates are the ones Act 1151 sets.
   *
   * Reported rather than assumed. The API cannot know why A&B's rates are what
   * they are — GRA's registration threshold rose to GHS 750,000, which puts a
   * small community pharmacy on either side of the line — so it says whether
   * they match the published figures and leaves the meaning to the owner. An
   * owner who has deviated on purpose sees that the system knows; one who
   * deviated by typo sees it too.
   *
   * `taxInclusivePricing` is not part of the comparison: GRA publishes rates, not
   * a convention for whether shelf prices include them.
   */
  matchesAct1151: boolean;
  /** GRA's own figures and where they came from, so the page can offer them. */
  act1151: {
    instrument: string;
    inForceFrom: string;
    source: string;
    retrieved: string;
    vatRate: number;
    nhilRate: number;
    getfundRate: number;
  };
  updatedAt: string;
}

/** What a settings form posts. Rates as typed: a string or a number. */
export interface TaxSettingsInput {
  taxInclusivePricing: boolean;
  vatRate: string | number;
  nhilRate: string | number;
  getfundRate: string | number;
}

function rateView(rate: number): RateView {
  return { rate, label: rateLabel(rate), decimal: rateDecimalString(rate) };
}

/**
 * The engine's door, applied to a stored row.
 *
 * Both readers go through here so there is one answer to "what does this row
 * mean", and so a row the engine cannot price is reported the same way whether
 * somebody opened the settings page or tried to take a sale.
 *
 * A refusal here is 500 and not 400, because it is our data being wrong rather
 * than the caller's input: `changeTaxSettings` writes text `rateDecimalString`
 * produced from a rate `parseRate` already accepted, so the only ways to reach
 * this are a manual `UPDATE` or a migration that went wrong. It carries a
 * message anyway. The error middleware withholds what it does not understand,
 * and an owner who cannot see why the settings page will not open is locked out
 * of the one screen that can put the rates right — while every sale in the
 * pharmacy is unpriceable until they do.
 */
function settingsFromRow(row: TaxSettingsRow): TaxSettings {
  try {
    return taxSettings({
      taxInclusivePricing: row.taxInclusivePricing,
      vatRate: row.vatRate,
      nhilRate: row.nhilRate,
      getfundRate: row.getfundRate,
    });
  } catch (error) {
    if (!isTaxError(error)) throw error;
    throw new HttpError(
      500,
      'The tax rates stored for this pharmacy cannot be charged, so no sale can be priced until they are corrected',
      {
        code: 'tax_settings_unreadable',
        // The engine's own wording and field, for the log line and for a page
        // that can point at the one setting to fix.
        details: { field: error.field ?? null, reason: error.message },
      }
    );
  }
}

function toView(row: TaxSettingsRow): TaxSettingsView {
  const settings = settingsFromRow(row);
  const combinedRate = settings.vatRate + settings.nhilRate + settings.getfundRate;

  return {
    taxInclusivePricing: settings.taxInclusivePricing,
    vat: rateView(settings.vatRate),
    nhil: rateView(settings.nhilRate),
    getfund: rateView(settings.getfundRate),
    combinedRate,
    combinedLabel: combinedRate > RATE_SCALE ? null : rateLabel(combinedRate),
    matchesAct1151:
      settings.vatRate === GRA_RATES.vatRate &&
      settings.nhilRate === GRA_RATES.nhilRate &&
      settings.getfundRate === GRA_RATES.getfundRate,
    act1151: {
      instrument: GRA_INSTRUMENT,
      inForceFrom: GRA_IN_FORCE_FROM,
      source: GRA_SOURCE,
      retrieved: GRA_RETRIEVED,
      vatRate: GRA_RATES.vatRate,
      nhilRate: GRA_RATES.nhilRate,
      getfundRate: GRA_RATES.getfundRate,
    },
    updatedAt: row.updatedAt,
  };
}

/** The settings page. `tax:read`. */
export async function readTaxSettingsView(pharmacyId: string): Promise<TaxSettingsView> {
  return toView(await readTaxSettings(pharmacyId));
}

/**
 * What a sale prices with. `tax:read`, and the reason that permission exists.
 *
 * A till cannot price a basket without the rates, so whoever can create a sale
 * has to be able to read them — and Phase 9's offline till has to cache them to
 * price anything at all during an outage. Reading is part of selling; changing
 * is `tax:change` and stays with the owner.
 */
export async function taxSettingsForPricing(pharmacyId: string): Promise<TaxSettings> {
  return settingsFromRow(await readTaxSettings(pharmacyId));
}

/**
 * The owner-only write. `tax:change`.
 *
 * Validates every setting before writing any of them, and reports all the
 * faults at once rather than the first. The engine's `taxSettings()` throws on
 * the first bad value, which is right for a pricing call and wrong for a form:
 * an owner who mistyped two rates should be told about both, not fix one, save,
 * and be told about the second.
 *
 * Nothing the engine refuses is allowed to escape as a `TaxError`. The route
 * validates the pricing mode with express-validator, but this service is also
 * called by Phase 6's write path, which does not go through that route — and a
 * `TaxError` reaching the error middleware is a 500 for what is plainly the
 * caller's mistake.
 *
 * What gets written is the canonical decimal string, not the text that arrived.
 * `'0.15'`, `0.15` and `'0.1500'` all store `'0.1500'`, which is the same value
 * by the round trip `money.test.ts` proves over all 10,001 rates — and storing
 * one spelling is what lets `matchesAct1151` compare integers instead of strings.
 *
 * The view returned is built from the row the database sent back, not from the
 * validated input. If the column stored something other than what was asked for,
 * the response says so instead of confirming a save that did not happen.
 */
export async function changeTaxSettings(
  pharmacyId: string,
  input: TaxSettingsInput
): Promise<TaxSettingsView> {
  const faults: TaxFault[] = TAX_RATE_FIELDS.map(({ key, label }) =>
    faultFrom(() => parseRate(input[key], label), key)
  ).filter((fault) => fault !== null);

  if (typeof input.taxInclusivePricing !== 'boolean') {
    // The engine's own guard, run through `faultFrom` so its wording is the
    // wording used rather than a second sentence meaning the same thing. It
    // cannot refuse the rates — those were just validated — so the fault it
    // produces is about the mode, and `taxInclusivePricing` is not a guess at
    // the field path: it is the name the engine itself puts on the error.
    const modeFault = faultFrom(
      () =>
        taxSettings({
          taxInclusivePricing: input.taxInclusivePricing,
          vatRate: input.vatRate,
          nhilRate: input.nhilRate,
          getfundRate: input.getfundRate,
        }),
      'taxInclusivePricing'
    );
    if (modeFault !== null) faults.push(modeFault);
  }

  if (faults.length > 0) throw validationErrorFromFaults(faults);

  const settings = taxSettings({
    taxInclusivePricing: input.taxInclusivePricing,
    vatRate: input.vatRate,
    nhilRate: input.nhilRate,
    getfundRate: input.getfundRate,
  });

  const row = await writeTaxSettings(pharmacyId, {
    taxInclusivePricing: settings.taxInclusivePricing,
    vatRate: rateDecimalString(settings.vatRate),
    nhilRate: rateDecimalString(settings.nhilRate),
    getfundRate: rateDecimalString(settings.getfundRate),
  });

  return toView(row);
}
