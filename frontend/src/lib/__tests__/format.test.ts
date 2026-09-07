/**
 * The formatter, checked on the values it will actually be handed.
 *
 * The interesting cases are not the happy ones — `'1234.5'` becoming
 * `'1,234.50'` is the easy half. The half that matters is what a total function
 * does with a value it cannot read, because these strings come off the wire and
 * the wire is not type-checked at runtime: a `null`, an empty string, a column
 * that was `numeric` in one environment and text in another. Each of those has
 * to become an em dash and never a confident wrong figure. A till that prints
 * "GHS 0.00" for an amount it failed to parse tells the operator the sale is
 * free; "—" tells them something is missing, which is the opposite instruction
 * and the honest one.
 *
 * Dates are asserted only where the assertion is timezone-independent. A
 * date-only string and a timestamp with no offset are both read as *local* time
 * by `parseISO`, so their formatted output does not move with the machine's
 * clock — those get exact assertions. A `Z`-suffixed timestamp is a real instant
 * and its wall-clock rendering depends on the timezone the tablet is set to, so
 * that one is checked for shape only.
 */

import { formatCedis, formatDate, formatDateTime, formatMoney, formatShortDate, MISSING as MISSING_TEXT } from '../format';

const MISSING = '—';

describe('the missing marker', () => {
  it('is the one dash every formatter leaves, and is exported for the ones that are not about money', () => {
    // `lib/reports.ts` formats a percentage, which `formatMoney` would pad to two
    // decimals and so misstate. It borrows this constant instead of holding its
    // own dash, and this is the assertion that makes the borrowing load-bearing:
    // a second convention for "nothing to show" would be two ways for a reader to
    // be told a figure is absent.
    expect(MISSING_TEXT).toBe(MISSING);
    expect(formatMoney(null)).toBe(MISSING_TEXT);
    expect(formatDate(null)).toBe(MISSING_TEXT);
    expect(formatDateTime(null)).toBe(MISSING_TEXT);
    expect(formatShortDate(null)).toBe(MISSING_TEXT);
  });
});

describe('formatMoney', () => {
  it('groups the integer part and fixes two decimals', () => {
    // The canonical case: a decimal string straight off `numeric`, one place,
    // becomes grouped thousands and a padded fraction.
    expect(formatMoney('1234.5')).toBe('1,234.50');
  });

  it('pads a whole number to two decimals', () => {
    expect(formatMoney('1000')).toBe('1,000.00');
    expect(formatMoney('0')).toBe('0.00');
  });

  it('leaves an already-two-decimal amount alone', () => {
    expect(formatMoney('12.34')).toBe('12.34');
    expect(formatMoney('0.05')).toBe('0.05');
  });

  it('groups across more than one comma', () => {
    expect(formatMoney('1000000')).toBe('1,000,000.00');
    expect(formatMoney('123456789.99')).toBe('123,456,789.99');
  });

  it('does not group a three-digit integer part', () => {
    // The grouping regex inserts a comma every three digits from the right; a
    // leading group of fewer than three must not gain a stray comma.
    expect(formatMoney('999')).toBe('999.00');
    expect(formatMoney('100')).toBe('100.00');
  });

  it('puts the minus sign outside the grouping', () => {
    // A refund or a reversal is negative. `'-1,234.50'` is readable; a sign
    // buried after the first digit would not be.
    expect(formatMoney('-1234.5')).toBe('-1,234.50');
    expect(formatMoney('-0.05')).toBe('-0.05');
  });

  it('truncates a third decimal rather than inventing a rounding rule', () => {
    // Money columns are `numeric(12, 2)`, so this cannot arise from the schema.
    // It is the defensive path for a hand-built string, and truncating is the
    // honest choice: rounding would apply a policy the caller never asked for.
    expect(formatMoney('1.999')).toBe('1.99');
    expect(formatMoney('12.3456')).toBe('12.34');
  });

  it('tolerates surrounding whitespace', () => {
    expect(formatMoney('  1234.50  ')).toBe('1,234.50');
  });

  it('returns an em dash for every value it cannot read', () => {
    // Total, not throwing. Each of these is a distinct way the wire can hand
    // back something that is not a money string, and each must degrade to the
    // same honest "missing" marker.
    expect(formatMoney(null)).toBe(MISSING);
    expect(formatMoney(undefined)).toBe(MISSING);
    expect(formatMoney('')).toBe(MISSING);
    expect(formatMoney('   ')).toBe(MISSING);
    expect(formatMoney('abc')).toBe(MISSING);
    expect(formatMoney('12.3.4')).toBe(MISSING);
    expect(formatMoney('GHS 12.00')).toBe(MISSING);
    expect(formatMoney('1,234.50')).toBe(MISSING);
    expect(formatMoney('.5')).toBe(MISSING);
    expect(formatMoney('-.5')).toBe(MISSING);
  });
});

describe('formatCedis', () => {
  it('prefixes the grouped amount with GHS, not the cedi sign', () => {
    // `GHS` rather than `₵`: a thermal receipt printer stops at ASCII, and a
    // receipt is a statutory document. The prefix is part of the figure here.
    expect(formatCedis('1234.5')).toBe('GHS 1,234.50');
    expect(formatCedis('0')).toBe('GHS 0.00');
  });

  it('returns a bare em dash with no prefix when there is no amount', () => {
    // `'GHS —'` would read as an amount that happens to be unknown but denominated
    // in cedis; the missing marker must stand alone so it cannot be mistaken for
    // a formatted figure.
    expect(formatCedis(null)).toBe(MISSING);
    expect(formatCedis(undefined)).toBe(MISSING);
    expect(formatCedis('')).toBe(MISSING);
    expect(formatCedis('abc')).toBe(MISSING);
  });
});

describe('formatDate', () => {
  it('renders a date-only string as day, short month, year', () => {
    // Date-only, so `parseISO` reads local midnight and the output does not move
    // with the timezone. This is the property an expiry date depends on: a batch
    // is sellable *on* its expiry date, and a display that shifted it by a day
    // would disagree with the rule the till enforces.
    expect(formatDate('2027-03-31')).toBe('31 Mar 2027');
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026');
  });

  it('returns an em dash for a missing or unreadable date', () => {
    expect(formatDate(null)).toBe(MISSING);
    expect(formatDate(undefined)).toBe(MISSING);
    expect(formatDate('')).toBe(MISSING);
    expect(formatDate('not-a-date')).toBe(MISSING);
  });
});

describe('formatDateTime', () => {
  it('renders a local timestamp with date and 24-hour time', () => {
    // No offset in the input, so `parseISO` treats it as local time and the
    // assertion is stable on any machine.
    expect(formatDateTime('2026-09-05T14:30:00')).toBe('5 Sep 2026, 14:30');
  });

  it('renders a Z-suffixed instant in the expected shape', () => {
    // The wall-clock part of a real instant depends on the tablet's timezone, so
    // only the shape is asserted: day, short month, year, then HH:mm.
    expect(formatDateTime('2026-09-05T14:30:00Z')).toMatch(
      /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}$/
    );
  });

  it('returns an em dash for a missing or unreadable timestamp', () => {
    expect(formatDateTime(null)).toBe(MISSING);
    expect(formatDateTime(undefined)).toBe(MISSING);
    expect(formatDateTime('')).toBe(MISSING);
    expect(formatDateTime('garbage')).toBe(MISSING);
  });
});

describe('formatShortDate', () => {
  it('drops the year, for an axis tick that has no room for one', () => {
    expect(formatShortDate('2026-09-05')).toBe('5 Sep');
    expect(formatShortDate('2026-12-31')).toBe('31 Dec');
  });

  it('is formatDate without the year, and not a different reading of the day', () => {
    // The two formatters are used on the same page — the short one on the chart's
    // ticks, the full one in the heading and the table. If they disagreed about
    // which day a wire date is, the chart would point at one column of the table
    // and label it as another.
    expect(formatDate('2026-09-05').startsWith(formatShortDate('2026-09-05'))).toBe(true);
  });

  it('returns an em dash for a missing or unreadable date', () => {
    expect(formatShortDate(null)).toBe(MISSING);
    expect(formatShortDate(undefined)).toBe(MISSING);
    expect(formatShortDate('')).toBe(MISSING);
    expect(formatShortDate('not-a-date')).toBe(MISSING);
  });
});
