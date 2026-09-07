import {
  COST_PRICE,
  UNIT_PRICE,
  toBoolean,
  toDateOnlyOrNull,
  toEnumMember,
  toInteger,
  toMoneyString,
  toText,
  toTextOrNull,
} from '../utils/coerce';
import { HttpError } from '../utils/http';
import { SELL_UNITS, VAT_TREATMENTS } from '../utils/schema-enums';

/**
 * The single authority on turning whatever arrived into something the database
 * will accept.
 *
 * Three entry points depend on this: the JSON routes (where express-validator has
 * already looked at the shape), the CSV importer (where every field is a string
 * from a spreadsheet and nothing has looked at it), and the offline queue in
 * Phase 9 (where a sale is replayed hours after it was typed). One set of rules
 * is the point; this suite is what stops them drifting.
 *
 * The messages are tested as hard as the values. The module's header promises
 * that no message names a table, a column, a constraint or a Postgres error code,
 * and an untested promise about error text is a promise that gets broken the
 * first time somebody catches a driver error and re-throws it.
 */

interface Failure {
  status: number;
  code: string | undefined;
  message: string;
}

/** Runs a coercer expected to refuse, and reports what it refused with. */
function failureOf(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) {
      return { status: error.status, code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error('expected the coercer to refuse, and it returned a value instead');
}

describe('toInteger', () => {
  const limits = { min: 1, max: 1_000_000 };

  it('accepts a whole number from a JSON body and from a CSV cell alike', () => {
    expect(toInteger(12, 'the quantity', limits)).toBe(12);
    expect(toInteger('12', 'the quantity', limits)).toBe(12);
    expect(toInteger('  12  ', 'the quantity', limits)).toBe(12);
    expect(toInteger(5.0, 'the quantity', limits)).toBe(5);
  });

  it('accepts an explicit sign, then lets the range decide', () => {
    expect(toInteger('+12', 'the quantity', limits)).toBe(12);
    // A negative is a real integer and is rejected by the range, not by the
    // format. The distinction matters because `adjustBatch` allows a minimum of
    // zero, so '-1' there has to read as "below the minimum" rather than "not a
    // number" — the first is a counting error, the second a broken file.
    expect(failureOf(() => toInteger('-1', 'the quantity', limits)).message).toBe(
      'The quantity must be 1 or more'
    );
  });

  it('refuses anything that is not a whole number', () => {
    for (const value of [5.5, '5.5', 'abc', '', '   ', '1e3', '1,000', null, undefined, {}, [], true]) {
      expect({ value, failure: failureOf(() => toInteger(value, 'the quantity', limits)) }).toEqual({
        value,
        failure: {
          status: 400,
          code: 'validation_failed',
          message: 'Enter the quantity as a whole number',
        },
      });
    }
  });

  it('refuses an integer too large for a JS number to hold exactly', () => {
    // Past 2^53 a double cannot represent every integer, so a quantity arriving
    // as one would be stored as a neighbour of what was typed — off by a unit,
    // with nothing in the ledger to say so.
    expect(failureOf(() => toInteger(2 ** 53, 'the quantity', limits)).message).toBe(
      'Enter the quantity as a whole number'
    );
    expect(failureOf(() => toInteger(1e300, 'the quantity', limits)).message).toBe(
      'Enter the quantity as a whole number'
    );
    // Fifteen digits is inside the safe range and is accepted.
    expect(toInteger('999999999999999', 'the quantity', { min: 0 })).toBe(999999999999999);
  });

  it('enforces both ends of the range, with the field name capitalised into the sentence', () => {
    expect(toInteger(1, 'the quantity', limits)).toBe(1);
    expect(toInteger(1_000_000, 'the quantity', limits)).toBe(1_000_000);
    expect(failureOf(() => toInteger(0, 'the quantity', limits)).message).toBe(
      'The quantity must be 1 or more'
    );
    expect(failureOf(() => toInteger(1_000_001, 'the quantity', limits)).message).toBe(
      'The quantity must be 1000000 or less'
    );
  });

  it('treats an omitted maximum as no maximum', () => {
    expect(toInteger(999_999_999, 'the offset', { min: 0 })).toBe(999_999_999);
  });
});

describe('toMoneyString', () => {
  it('returns a decimal string, never a JS number', () => {
    // `numeric` arrives as a string and leaves as one. A double cannot hold 0.1
    // exactly, and a till that adds money in doubles is off by a pesewa on some
    // totals — the kind of difference that surfaces in a month-end reconciliation
    // and cannot be traced back to a line.
    expect(toMoneyString('12.50', UNIT_PRICE)).toBe('12.50');
    expect(toMoneyString(12.5, UNIT_PRICE)).toBe('12.5');
    expect(toMoneyString(0, UNIT_PRICE)).toBe('0');
    expect(toMoneyString('0.00', UNIT_PRICE)).toBe('0.00');
    expect(typeof toMoneyString('12.50', UNIT_PRICE)).toBe('string');
  });

  it('leaves the digits as typed rather than normalising them', () => {
    // Postgres accepts leading zeros in a `numeric` literal, and rewriting the
    // text here would mean the ledger could hold an amount nobody typed.
    expect(toMoneyString('0012.50', UNIT_PRICE)).toBe('0012.50');
    expect(toMoneyString('  12.50  ', UNIT_PRICE)).toBe('12.50');
  });

  it('refuses the shapes a spreadsheet produces that are not amounts', () => {
    for (const value of ['1e3', '1,000', '12.50 GHS', '-5', '.5', '5.', 'abc']) {
      expect({ value, failure: failureOf(() => toMoneyString(value, UNIT_PRICE)) }).toEqual({
        value,
        failure: {
          status: 400,
          code: 'validation_failed',
          message: 'Enter unit price as an amount, for example 12.50',
        },
      });
    }
  });

  it('refuses a missing amount rather than reading it as zero', () => {
    // The hole this closed: a route doing `String(input.costPrice ?? '0')` turned
    // an absent cost price into the literal text "undefined" and handed that to
    // the driver. Coercing here is what makes that unreachable.
    //
    // An empty cell is grouped with the missing values, not with the malformed
    // ones, and gets the shorter message: "Enter a unit price" is the right thing
    // to say to somebody who left the column blank, where "for example 12.50"
    // would imply they had typed something wrong.
    for (const value of [null, undefined, '', '   ']) {
      expect({ value, failure: failureOf(() => toMoneyString(value, UNIT_PRICE)) }).toEqual({
        value,
        failure: {
          status: 400,
          code: 'validation_failed',
          message: 'Enter a unit price',
        },
      });
    }
  });

  it('refuses a value that is not a number at all', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) {
      expect(failureOf(() => toMoneyString(value, UNIT_PRICE)).message).toBe(
        'Enter unit price as an amount'
      );
    }
  });

  it('refuses a number that stringifies into exponent form', () => {
    // A spreadsheet holds this as a number and shows it as 1E+21. `String()` of it
    // is not a decimal literal, so it is caught by the shape check rather than
    // sneaking through as a very large amount.
    expect(failureOf(() => toMoneyString(1e21, UNIT_PRICE)).message).toBe(
      'Enter unit price as an amount, for example 12.50'
    );
  });

  it('refuses more decimal places than the column holds, instead of letting Postgres round', () => {
    // `numeric(12, 2)` would silently store `2.345` as `2.35`. A cost price typed
    // to four places and stored to two is a margin figure nobody chose.
    expect(failureOf(() => toMoneyString('2.345', UNIT_PRICE)).message).toBe(
      'Unit price cannot have more than 2 decimal places'
    );
    // The same value is fine for a cost price, which is `numeric(12, 4)`.
    expect(toMoneyString('2.345', COST_PRICE)).toBe('2.345');
    expect(failureOf(() => toMoneyString('2.34567', COST_PRICE)).message).toBe(
      'Cost price cannot have more than 4 decimal places'
    );
  });

  it('refuses an amount wider than the column, before it becomes a driver error', () => {
    // numeric(12, 2) holds ten digits before the point; numeric(12, 4) holds eight.
    expect(toMoneyString('1234567890.00', UNIT_PRICE)).toBe('1234567890.00');
    expect(failureOf(() => toMoneyString('12345678901.00', UNIT_PRICE)).message).toBe(
      'Unit price is too large'
    );
    expect(toMoneyString('12345678.0000', COST_PRICE)).toBe('12345678.0000');
    expect(failureOf(() => toMoneyString('123456789.0000', COST_PRICE)).message).toBe(
      'Cost price is too large'
    );
  });

  it('does not count leading zeros as digits of width', () => {
    // A spreadsheet can emit '0000000012.50'. That is twelve pesos and fifty, not
    // an overflow, and refusing it would fail an import over formatting.
    expect(toMoneyString('0000000012.50', UNIT_PRICE)).toBe('0000000012.50');
  });
});

describe('toBoolean', () => {
  it('passes a real boolean through', () => {
    expect(toBoolean(true, 'requires prescription')).toBe(true);
    expect(toBoolean(false, 'requires prescription')).toBe(false);
  });

  it('reads the words a spreadsheet cell holds, in any case', () => {
    for (const value of ['true', 'TRUE', 'True', '1', 'yes', 'Y', 'on']) {
      expect({ value, result: toBoolean(value, 'requires prescription') }).toEqual({
        value,
        result: true,
      });
    }
    for (const value of ['false', 'FALSE', '0', 'no', 'N', 'off']) {
      expect({ value, result: toBoolean(value, 'requires prescription') }).toEqual({
        value,
        result: false,
      });
    }
    expect(toBoolean('  yes  ', 'requires prescription')).toBe(true);
  });

  it('reads an empty cell as false, which is also the column default', () => {
    // Refusing a blank would fail every row of a template that has the column
    // present and mostly empty, which is the normal case.
    for (const value of ['', '   ', null, undefined]) {
      expect({ value, result: toBoolean(value, 'requires prescription') }).toEqual({
        value,
        result: false,
      });
    }
  });

  it('accepts the numeric spelling of a boolean', () => {
    // A JSON client that sends `1` means true. Reading it as false because it is
    // not a string would make a prescription-only medicine sellable over the
    // counter, and nothing in the response would say the value was reinterpreted.
    expect(toBoolean(1, 'requires prescription')).toBe(true);
    expect(toBoolean(0, 'requires prescription')).toBe(false);
  });

  it('refuses a value that is not a boolean in any spelling', () => {
    // Not a silent false. "We could not tell" and "no" are different answers, and
    // for a prescription flag the difference is a dispensing control.
    for (const value of [2, -1, {}, [], 'maybe', 'oui']) {
      expect({ value, failure: failureOf(() => toBoolean(value, 'requires prescription')) }).toEqual({
        value,
        failure: {
          status: 400,
          code: 'validation_failed',
          message: 'Enter requires prescription as yes or no',
        },
      });
    }
  });
});

describe('toDateOnlyOrNull', () => {
  it('returns the date as typed', () => {
    expect(toDateOnlyOrNull('2026-03-15', 'the expiry date')).toBe('2026-03-15');
    expect(toDateOnlyOrNull('  2026-03-15  ', 'the expiry date')).toBe('2026-03-15');
  });

  it('treats an empty cell as undated stock rather than an error', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect({ value, result: toDateOnlyOrNull(value, 'the expiry date') }).toEqual({
        value,
        result: null,
      });
    }
  });

  it('refuses a date the calendar does not contain', () => {
    // `isDateOnly` round-trips through a real date, so 30 February is refused
    // instead of being rolled forward to 2 March. An expiry date that does not
    // exist is a typing error worth stopping at the door: rolled forward, stock
    // would silently become sellable for two extra days.
    for (const value of ['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29']) {
      expect({ value, failure: failureOf(() => toDateOnlyOrNull(value, 'the expiry date')) }).toEqual({
        value,
        failure: {
          status: 400,
          code: 'validation_failed',
          message: 'Enter the expiry date as a date in YYYY-MM-DD form',
        },
      });
    }
  });

  it('refuses a date in any other shape', () => {
    for (const value of ['15/03/2026', '03-15-2026', '15 March 2026', '2026-3-5', '2026-03-15T00:00:00Z']) {
      expect(failureOf(() => toDateOnlyOrNull(value, 'the expiry date')).message).toBe(
        'Enter the expiry date as a date in YYYY-MM-DD form'
      );
    }
  });

  it('refuses a non-string rather than reading it as undated', () => {
    // The dangerous direction. `20260315` arriving as a number would otherwise
    // become null, and null means "undated stock", which `fefo.ts` treats as
    // sellable forever — an expiry date silently turned into no expiry at all.
    for (const value of [20260315, {}, [], true]) {
      expect(failureOf(() => toDateOnlyOrNull(value, 'the expiry date')).message).toBe(
        'Enter the expiry date as a date in YYYY-MM-DD form'
      );
    }
  });
});

describe('toEnumMember', () => {
  it('returns the value when it is one of the allowed ones', () => {
    expect(toEnumMember('exempt', VAT_TREATMENTS, 'the VAT treatment')).toBe('exempt');
    expect(toEnumMember('  pack  ', SELL_UNITS, 'the selling unit')).toBe('pack');
  });

  it('is case-sensitive, because Postgres enum labels are', () => {
    // Accepting 'Exempt' here would mean the SQL comparison or the parameter cast
    // fails later with a 22P02 — the exact error this module exists to prevent.
    for (const value of ['Exempt', 'EXEMPT', 'Cash']) {
      const allowed = value.toLowerCase().startsWith('c') ? (['cash', 'momo'] as const) : VAT_TREATMENTS;
      expect(failureOf(() => toEnumMember(value, allowed, 'the VAT treatment')).message).toBe(
        `Enter the VAT treatment as one of: ${allowed.join(', ')}`
      );
    }
  });

  it('refuses a value outside the list and names the list', () => {
    // 'reduced' rather than an arbitrary word: a reduced rate is a real VAT
    // treatment in most jurisdictions and is not one of Ghana's three, so this
    // is the mistake a client is actually likely to make.
    expect(failureOf(() => toEnumMember('reduced', VAT_TREATMENTS, 'the VAT treatment')).message).toBe(
      'Enter the VAT treatment as one of: standard, exempt, zero_rated'
    );
  });

  it('refuses a missing or non-string value rather than defaulting it', () => {
    // An enum with a schema default is the caller's decision to make explicitly;
    // silently choosing one here would hide a column the importer never read.
    for (const value of [undefined, null, '', 1, {}, []]) {
      expect(failureOf(() => toEnumMember(value, VAT_TREATMENTS, 'the VAT treatment')).message).toBe(
        'Enter the VAT treatment as one of: standard, exempt, zero_rated'
      );
    }
  });
});

describe('toText and toTextOrNull', () => {
  it('trims required text and refuses an empty one', () => {
    expect(toText('  Paracetamol 500mg  ', 'the product name', 200)).toBe('Paracetamol 500mg');
    for (const value of ['', '   ', null, undefined, 12, {}]) {
      expect(failureOf(() => toText(value, 'the product name', 200)).message).toBe(
        'Enter the product name'
      );
    }
  });

  it('caps required text at the column width', () => {
    expect(toText('abc', 'the product name', 3)).toBe('abc');
    expect(failureOf(() => toText('abcd', 'the product name', 3)).message).toBe(
      'The product name must be 3 characters or fewer'
    );
  });

  it('turns an empty optional cell into null rather than an empty string', () => {
    for (const value of ['', '   ', null, undefined]) {
      expect({ value, result: toTextOrNull(value, 'the generic name', 200) }).toEqual({
        value,
        result: null,
      });
    }
  });

  it('caps optional text the same way', () => {
    expect(toTextOrNull('  Amoxicillin  ', 'the generic name', 13)).toBe('Amoxicillin');
    expect(failureOf(() => toTextOrNull('abcd', 'the generic name', 3)).message).toBe(
      'The generic name must be 3 characters or fewer'
    );
  });

  it('refuses a non-string optional value rather than dropping it', () => {
    // Same shape as the date and the boolean: a value that arrived and could not
    // be read is a 400, not a silent null. A note that vanishes is an audit trail
    // with a hole in it.
    for (const value of [12, {}, [], true]) {
      expect(failureOf(() => toTextOrNull(value, 'the generic name', 200)).message).toBe(
        'Enter the generic name as text'
      );
    }
  });
});

describe('every refusal', () => {
  /**
   * One bad input per coercer, gathered so the two cross-cutting promises below
   * are checked against the whole surface rather than against whichever function
   * a new test happened to touch.
   */
  const refusals: ReadonlyArray<{ name: string; run: () => unknown }> = [
    { name: 'toInteger', run: () => toInteger('abc', 'the quantity', { min: 1 }) },
    { name: 'toInteger range', run: () => toInteger(0, 'the quantity', { min: 1 }) },
    { name: 'toInteger unsafe', run: () => toInteger(2 ** 53, 'the quantity', { min: 1 }) },
    { name: 'toMoneyString shape', run: () => toMoneyString('1e3', UNIT_PRICE) },
    { name: 'toMoneyString missing', run: () => toMoneyString(null, UNIT_PRICE) },
    { name: 'toMoneyString decimals', run: () => toMoneyString('2.345', UNIT_PRICE) },
    { name: 'toMoneyString width', run: () => toMoneyString('12345678901', UNIT_PRICE) },
    { name: 'toBoolean', run: () => toBoolean('maybe', 'requires prescription') },
    { name: 'toBoolean type', run: () => toBoolean(2, 'requires prescription') },
    { name: 'toDateOnlyOrNull', run: () => toDateOnlyOrNull('2026-02-30', 'the expiry date') },
    {
      name: 'toDateOnlyOrNull type',
      run: () => toDateOnlyOrNull(20260315, 'the expiry date'),
    },
    { name: 'toEnumMember', run: () => toEnumMember('nope', VAT_TREATMENTS, 'the VAT treatment') },
    { name: 'toText', run: () => toText('', 'the product name', 200) },
    { name: 'toText length', run: () => toText('abcd', 'the product name', 3) },
    { name: 'toTextOrNull length', run: () => toTextOrNull('abcd', 'the generic name', 3) },
    { name: 'toTextOrNull type', run: () => toTextOrNull(12, 'the generic name', 200) },
  ];

  it('is a 400, never a 500', () => {
    // Every one of these is the caller's input being wrong. A 500 here would be
    // an unhandled driver error wearing a coercer's clothes, and the offline queue
    // in Phase 9 retries 5xx and does not retry 4xx — so a mis-classified refusal
    // becomes a sale replayed forever.
    const wrong = refusals
      .map((entry) => ({ name: entry.name, status: failureOf(entry.run).status }))
      .filter((entry) => entry.status !== 400);
    expect(wrong).toEqual([]);
  });

  it('carries the stable machine-readable code the offline queue keys on', () => {
    const wrong = refusals
      .map((entry) => ({ name: entry.name, code: failureOf(entry.run).code }))
      .filter((entry) => entry.code !== 'validation_failed');
    expect(wrong).toEqual([]);
  });

  it('says nothing about the schema', () => {
    // The module's promise, checked. "Cost price cannot have more than 2 decimal
    // places" is help to the person at the counter; "numeric field overflow" or
    // "violates check constraint stock_batches_quantity_check" is a disclosure of
    // the schema in an error body a browser can read.
    const forbidden = [
      'numeric',
      'constraint',
      'violat',
      'column',
      'table',
      'postgres',
      'sql',
      'varchar',
      'character varying',
      'syntax',
      'integer',
      '22p02',
      '23514',
      'null value',
    ];

    const leaks = refusals.flatMap((entry) => {
      const message = failureOf(entry.run).message.toLowerCase();
      return forbidden
        .filter((word) => message.includes(word))
        .map((word) => `${entry.name}: "${word}" appears in "${message}"`);
    });

    expect(leaks).toEqual([]);
  });

  it('writes every message for a person', () => {
    // Precise rather than heuristic, and narrower than it first was. An earlier
    // version of this test banned underscores and so failed on
    // "one of: standard, exempt, zero_rated" — but those are the literal values
    // the caller has to type, and a message that translated them into words would
    // be telling the truth about the enum and lying about the input.
    const suspect = refusals
      .map((entry) => ({ name: entry.name, message: failureOf(entry.run).message }))
      .filter(
        (entry) =>
          // A bare field name or an empty string is a bug, not an instruction.
          entry.message.length < 12 ||
          // Every message in this module opens with a verb or a field name.
          !/^[A-Z]/u.test(entry.message) ||
          // An unsubstituted placeholder reaching a customer.
          entry.message.includes('${') ||
          // The exact failure mode of `String(value ?? '0')`: a JS sentinel
          // printed into a sentence and presented as though it meant something.
          /\b(undefined|null|nan)\b/iu.test(entry.message)
      );
    expect(suspect).toEqual([]);
  });
});
