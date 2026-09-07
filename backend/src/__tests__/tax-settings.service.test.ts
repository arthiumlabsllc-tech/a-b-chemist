jest.mock('../repositories/tax-settings.repository', () => ({
  // The repository is mocked and the shared engine deliberately is not. The
  // engine is the thing this service exists to hand rates to: mocking it would
  // replace the rule under test with a stub that agrees with whatever this file
  // assumed, and every assertion below about canonicalisation, the combined
  // label and what the view carries would be a fiction. That the statements are
  // valid SQL is the harness in database/tests.
  readTaxSettings: jest.fn(),
  writeTaxSettings: jest.fn(),
}));

import {
  GRA_IN_FORCE_FROM,
  GRA_INSTRUMENT,
  GRA_RATES,
  GRA_SOURCE,
} from 'a-and-b-chemist-shared';
import {
  readTaxSettings,
  writeTaxSettings,
  type TaxSettingsRow,
  type TaxSettingsWrite,
} from '../repositories/tax-settings.repository';
import {
  changeTaxSettings,
  readTaxSettingsView,
  taxSettingsForPricing,
} from '../services/tax-settings.service';
import { HttpError } from '../utils/http';

/**
 * What the pharmacy charges, as the API sees it.
 *
 * Three things are worth proving here and nowhere else. That the view carries
 * both spellings of a rate, because a receipt needs `'15%'` and a form needs
 * `'0.1500'` and a service that returned one would push the conversion into two
 * consumers. That a write is canonicalised, so `'0.15'` and `0.15` and
 * `'0.1500'` all store the same text and `matchesAct1151` can compare integers.
 * And that a refusal happens before the write rather than part way through it.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const UPDATED_AT = '2026-09-01T08:00:00.000Z';

const readMock = readTaxSettings as jest.Mock;
const writeMock = writeTaxSettings as jest.Mock;

/**
 * A complete row rather than a partial one cast to the interface: if
 * `TaxSettingsRow` grows a field, this file stops compiling instead of quietly
 * feeding the service a row no database would return.
 *
 * The defaults are the schema's own, from `database/init.sql`, which is Act 1151
 * as GRA publishes it and `tax_inclusive_pricing` true.
 */
function row(overrides: Partial<TaxSettingsRow> = {}): TaxSettingsRow {
  return {
    pharmacyId: PHARMACY,
    taxInclusivePricing: true,
    vatRate: '0.1500',
    nhilRate: '0.0250',
    getfundRate: '0.0250',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function errorFrom(run: () => Promise<unknown>): Promise<HttpError> {
  return run().then(
    () => {
      throw new Error('expected the service to refuse, and it returned a value instead');
    },
    (error: unknown) => {
      if (error instanceof HttpError) return error;
      throw error;
    }
  );
}

/** The `details` array the envelope carries, narrowed to what these tests assert. */
function detailsOf(error: HttpError): { field: string; message: string; code?: string }[] {
  return error.details as { field: string; message: string; code?: string }[];
}

beforeEach(() => {
  jest.clearAllMocks();
  readMock.mockResolvedValue(row());
  // Echoes what it was asked to store, which is what the real statement does.
  writeMock.mockImplementation(
    async (_pharmacyId: string, write: TaxSettingsWrite): Promise<TaxSettingsRow> =>
      row({ ...write })
  );
});

describe('readTaxSettingsView', () => {
  it('carries every rate in both spellings, and the integer the engine prices with', async () => {
    const view = await readTaxSettingsView(PHARMACY);

    // GRA requires the receipt to name the rate beside each levy, and it names it
    // as a percentage. The column stores a fraction. The engine wants an integer
    // in ten-thousandths. All three are here so no consumer has to convert.
    expect(view.vat).toEqual({ rate: 1_500, label: '15%', decimal: '0.1500' });
    expect(view.nhil).toEqual({ rate: 250, label: '2.5%', decimal: '0.0250' });
    expect(view.getfund).toEqual({ rate: 250, label: '2.5%', decimal: '0.0250' });
    expect(view.taxInclusivePricing).toBe(true);
    expect(view.updatedAt).toBe(UPDATED_AT);
  });

  it('adds the three into the figure a customer actually experiences', async () => {
    const view = await readTaxSettingsView(PHARMACY);
    // Act 1151 charges all three on the same base, so they add: 15 + 2.5 + 2.5.
    // Before the reform they did not, and a combined figure would have been
    // wrong by GHS 9 on GRA's own 1,000 cedi example.
    expect(view.combinedRate).toBe(2_000);
    expect(view.combinedLabel).toBe('20%');
  });

  it('reports that the stored rates are GRA\'s, and says where GRA\'s came from', async () => {
    const view = await readTaxSettingsView(PHARMACY);
    expect(view.matchesAct1151).toBe(true);
    // Literals, on purpose. These five facts are what GRA published and the
    // fixture in the shared package transcribes; writing them out here means a
    // transcription slip fails in two packages rather than being copied from one
    // into the other. A settings page that shows rates without saying what they
    // are meant to be is a page an owner cannot audit, so the provenance is part
    // of the response rather than a comment in a file nobody opens.
    expect(view.act1151).toEqual({
      instrument: 'Value Added Tax Act, 2025 (Act 1151)',
      inForceFrom: '2026-01-01',
      source: 'https://gra.gov.gh/domestic-tax/tax-types/vat/',
      retrieved: '2026-09',
      vatRate: 1_500,
      nhilRate: 250,
      getfundRate: 250,
    });
    // And the same figures the fixture carries, so the two cannot drift apart
    // while both stay plausible.
    expect(view.act1151.instrument).toBe(GRA_INSTRUMENT);
    expect(view.act1151.inForceFrom).toBe(GRA_IN_FORCE_FROM);
    expect(view.act1151.source).toBe(GRA_SOURCE);
    expect(view.act1151.vatRate).toBe(GRA_RATES.vatRate);
    expect(view.act1151.nhilRate).toBe(GRA_RATES.nhilRate);
    expect(view.act1151.getfundRate).toBe(GRA_RATES.getfundRate);
  });

  it('says when the stored rates are not GRA\'s, one rate at a time', async () => {
    // Each of the three, changed on its own, so a comparison that checked two of
    // them and missed the third cannot pass.
    for (const overrides of [
      { vatRate: '0.1400' },
      { nhilRate: '0.0200' },
      { getfundRate: '0.0000' },
    ]) {
      readMock.mockResolvedValue(row(overrides));
      const view = await readTaxSettingsView(PHARMACY);
      expect({ overrides, matchesAct1151: view.matchesAct1151 }).toEqual({
        overrides,
        matchesAct1151: false,
      });
    }
  });

  it('does not make the pricing mode part of matching GRA, which publishes rates and not shelf prices', async () => {
    readMock.mockResolvedValue(row({ taxInclusivePricing: false }));
    const view = await readTaxSettingsView(PHARMACY);
    expect(view.taxInclusivePricing).toBe(false);
    expect(view.matchesAct1151).toBe(true);
  });

  it('reports a pharmacy that is not VAT-registered rather than inventing one', async () => {
    // All three at zero. The engine charges nothing, and the view says so in the
    // same words it would use for any other rates — there is no separate
    // "registered" flag, because whether A&B is registered is a fact about A&B
    // and the rates are how that fact is recorded.
    readMock.mockResolvedValue(
      row({ vatRate: '0.0000', nhilRate: '0.0000', getfundRate: '0.0000' })
    );
    const view = await readTaxSettingsView(PHARMACY);
    expect(view.combinedRate).toBe(0);
    expect(view.combinedLabel).toBe('0%');
    expect(view.matchesAct1151).toBe(false);
    expect(view.vat).toEqual({ rate: 0, label: '0%', decimal: '0.0000' });
  });

  it('degrades to no combined label past 100% instead of failing the page', async () => {
    // Each rate is individually legal — the column holds up to 9.9999 and
    // `parseRate` up to 1 — so a sum of three can pass the range `rateLabel`
    // asserts. Refusing to render the settings page over it would lock the owner
    // out of the one screen that can put the rates right.
    readMock.mockResolvedValue(
      row({ vatRate: '1.0000', nhilRate: '1.0000', getfundRate: '1.0000' })
    );
    const view = await readTaxSettingsView(PHARMACY);
    expect(view.combinedRate).toBe(30_000);
    expect(view.combinedLabel).toBeNull();
    // Each rate still renders, so the page still shows what is stored.
    expect(view.vat.label).toBe('100%');
  });

  it('refuses to describe a row the engine cannot price, and says it is our data and not the caller', async () => {
    // Reachable: somebody ran an UPDATE by hand, or a migration went wrong. The
    // alternative is a view that shows a rate no sale could ever be charged at,
    // which is worse than an error because it looks like an answer.
    //
    // 500 rather than 400, because nothing about the request was wrong. The
    // message is still carried — the middleware withholds only what it does not
    // understand — because an owner who cannot see why this page will not open
    // is locked out of the one screen that can fix it.
    readMock.mockResolvedValue(row({ vatRate: '9.9999' }));
    const error = await errorFrom(() => readTaxSettingsView(PHARMACY));
    expect(error.status).toBe(500);
    expect(error.code).toBe('tax_settings_unreadable');
    expect(error.message).toBe(
      'The tax rates stored for this pharmacy cannot be charged, so no sale can be priced until they are corrected'
    );
    expect(error.details).toEqual({
      field: 'the VAT rate',
      reason: 'Enter the VAT rate as a decimal with at most four places, between 0 and 1',
    });
  });
});

describe('taxSettingsForPricing', () => {
  it('returns the engine\'s own frozen object, with integer rates and no strings', async () => {
    const settings = await taxSettingsForPricing(PHARMACY);
    expect(settings).toEqual({
      taxInclusivePricing: true,
      vatRate: 1_500,
      nhilRate: 250,
      getfundRate: 250,
    });
    expect(Object.isFrozen(settings)).toBe(true);
  });

  it('is not the view, so a sale cannot be priced from something a page renders', async () => {
    const settings = (await taxSettingsForPricing(PHARMACY)) as unknown as Record<
      string,
      unknown
    >;
    // The view carries `label` and `decimal` strings for a human. Pricing from
    // those would mean parsing a receipt-shaped string back into a rate, in the
    // till, on every sale.
    expect(settings.label).toBeUndefined();
    expect(settings.decimal).toBeUndefined();
    expect(settings.vat).toBeUndefined();
    expect(settings.combinedRate).toBeUndefined();
    expect(settings.matchesAct1151).toBeUndefined();
  });

  it('reads the row rather than remembering it', async () => {
    // No cache, on purpose. One select of one row per sale is the cheapest thing
    // in the request, and a cache is the only way this could charge a rate that
    // is not the one in the database — a failure no receipt would reveal,
    // because the receipt snapshots the same cached rates and agrees with itself.
    await taxSettingsForPricing(PHARMACY);
    await taxSettingsForPricing(PHARMACY);
    expect(readMock).toHaveBeenCalledTimes(2);
  });

  it('reports an unreadable row the same way the settings page does', async () => {
    // One answer to "what does this row mean", whichever reader asked. A sale
    // that failed differently from the page describing the same broken rates
    // would be two diagnoses of one fault, and the till is the one place a
    // cashier cannot go and look.
    readMock.mockResolvedValue(row({ nhilRate: '0.025000' }));
    const error = await errorFrom(() => taxSettingsForPricing(PHARMACY));
    expect(error.status).toBe(500);
    expect(error.code).toBe('tax_settings_unreadable');
  });
});

describe('changeTaxSettings', () => {
  it('stores the canonical four-place text, whichever spelling arrived', async () => {
    // `rateDecimalString` produces the text and `money.test.ts` proves it
    // round-trips all 10,001 rates back through `parseRate`. Storing one
    // spelling is what lets the comparison against GRA be about integers.
    //
    // `'.15'` is absent because `parseRate` refuses it: the pattern requires a
    // leading digit, so a rate typed without one is rejected rather than
    // guessed at. That is the engine's decision and this test does not get to
    // disagree with it.
    const spellings: [string | number, string][] = [
      ['0.15', '0.1500'],
      [0.15, '0.1500'],
      ['0.1500', '0.1500'],
      ['1', '1.0000'],
      [1, '1.0000'],
      ['0', '0.0000'],
    ];
    for (const [vatRate, stored] of spellings) {
      writeMock.mockClear();
      await changeTaxSettings(PHARMACY, {
        taxInclusivePricing: true,
        vatRate,
        nhilRate: '0.0250',
        getfundRate: '0.0250',
      });
      const write = writeMock.mock.calls[0]?.[1] as TaxSettingsWrite;
      expect({ vatRate, stored, write: write.vatRate }).toEqual({ vatRate, stored, write: stored });
    }
  });

  it('writes all four settings, so a stale form cannot keep three it read earlier', async () => {
    await changeTaxSettings(PHARMACY, {
      taxInclusivePricing: false,
      vatRate: '0.1500',
      nhilRate: '0.0250',
      getfundRate: '0.0250',
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith(PHARMACY, {
      taxInclusivePricing: false,
      vatRate: '0.1500',
      nhilRate: '0.0250',
      getfundRate: '0.0250',
    });
  });

  it('reports every bad rate at once, not the first one it meets', async () => {
    const error = await errorFrom(() =>
      changeTaxSettings(PHARMACY, {
        taxInclusivePricing: true,
        vatRate: '15%',
        nhilRate: '0.02500',
        getfundRate: '2.5',
      })
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('validation_failed');
    // One envelope for every rejected input in this API, so the till shows one
    // kind of red whichever layer refused.
    expect(error.message).toBe('Some details need correcting before this can be saved');
    expect(detailsOf(error).map((fault) => fault.field)).toEqual([
      'vatRate',
      'nhilRate',
      'getfundRate',
    ]);
    expect(detailsOf(error)[0]).toEqual({
      field: 'vatRate',
      message: 'Enter the VAT rate as a decimal with at most four places, between 0 and 1',
      code: 'rate_out_of_range',
    });
  });

  it('names the field the way a form does and the way the engine words it', async () => {
    // The path is `nhilRate`, because that is what the input is called. The
    // message says "the NHIL rate", because that is what the engine already
    // writes and an owner reads a sentence rather than a camelCase key.
    const error = await errorFrom(() =>
      changeTaxSettings(PHARMACY, {
        taxInclusivePricing: true,
        vatRate: '0.1500',
        nhilRate: 1.5,
        getfundRate: '0.0250',
      })
    );
    expect(detailsOf(error)).toEqual([
      {
        field: 'nhilRate',
        message: 'Enter the NHIL rate as a decimal between 0 and 1',
        code: 'rate_out_of_range',
      },
    ]);
  });

  it('refuses before writing anything, so a rejected save cannot half-land', async () => {
    await errorFrom(() =>
      changeTaxSettings(PHARMACY, {
        taxInclusivePricing: true,
        vatRate: '0.1500',
        nhilRate: 'nonsense',
        getfundRate: '0.0250',
      })
    );
    expect(writeMock).not.toHaveBeenCalled();
    // And the rates in force are untouched, which is the consequence that
    // matters: a pharmacy mid-refusal is still charging what it was charging.
    expect(readMock).not.toHaveBeenCalled();
  });

  it('refuses a rate that arrived as arithmetic rather than as something typed', async () => {
    // `0.1 + 0.2` is `0.30000000000000004`. A rate that has already been through
    // floating-point arithmetic is a rate nobody wrote down, and guessing at it
    // is how a 15% VAT becomes 30%.
    const error = await errorFrom(() =>
      changeTaxSettings(PHARMACY, {
        taxInclusivePricing: true,
        vatRate: 0.1 + 0.2,
        nhilRate: '0.0250',
        getfundRate: '0.0250',
      })
    );
    expect(detailsOf(error)[0]?.code).toBe('rate_out_of_range');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('answers with what the database stored, not with what was asked for', async () => {
    // A row that came back different from the write is the case this pins: the
    // response has to describe the database. Confirming the input instead would
    // tell the owner their change took effect when it did not.
    writeMock.mockResolvedValue(row({ vatRate: '0.1250', updatedAt: '2026-09-04T09:30:00.000Z' }));

    const view = await changeTaxSettings(PHARMACY, {
      taxInclusivePricing: true,
      vatRate: '0.1500',
      nhilRate: '0.0250',
      getfundRate: '0.0250',
    });

    expect(view.vat).toEqual({ rate: 1_250, label: '12.5%', decimal: '0.1250' });
    expect(view.matchesAct1151).toBe(false);
    expect(view.updatedAt).toBe('2026-09-04T09:30:00.000Z');
  });

  it('refuses a pricing mode that is not a boolean, in the envelope every other refusal uses', async () => {
    // `taxSettings()` guards this and the route validates it too. Both, because
    // the route guard produces the field path and the engine guard cannot be
    // removed — and Phase 6 calls this service without going through a route at
    // all, where a raw `TaxError` would arrive at the error middleware and
    // become a 500 for what is plainly the caller's mistake.
    const error = await errorFrom(() =>
      changeTaxSettings(PHARMACY, {
        taxInclusivePricing: 'yes' as unknown as boolean,
        vatRate: '0.1500',
        nhilRate: '0.0250',
        getfundRate: '0.0250',
      })
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('validation_failed');
    // The engine's wording, not a second sentence meaning the same thing, and
    // the field path is the one the engine itself names.
    expect(detailsOf(error)).toEqual([
      {
        field: 'taxInclusivePricing',
        message: 'Tax-inclusive pricing must be true or false',
        code: 'rate_out_of_range',
      },
    ]);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('reports a bad mode and bad rates together, rather than making the owner guess twice', async () => {
    const error = await errorFrom(() =>
      changeTaxSettings(PHARMACY, {
        taxInclusivePricing: undefined as unknown as boolean,
        vatRate: '15%',
        nhilRate: '0.0250',
        getfundRate: '0.0250',
      })
    );
    expect(detailsOf(error).map((fault) => fault.field)).toEqual([
      'vatRate',
      'taxInclusivePricing',
    ]);
    expect(writeMock).not.toHaveBeenCalled();
  });
});
