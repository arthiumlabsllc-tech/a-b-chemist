import {
  EMPTY_SALES_FILTERS,
  outstandingBalance,
  paymentAmountBody,
  salesFiltersActive,
  salesQueryFrom,
  validateDateRange,
  validateVoidReason,
} from '../sales';

describe('salesQueryFrom', () => {
  it('always carries limit and offset', () => {
    expect(salesQueryFrom(EMPTY_SALES_FILTERS, 50, 0)).toEqual({ limit: 50, offset: 0 });
  });

  it('omits every unset filter rather than sending it empty', () => {
    const query = salesQueryFrom(
      { status: '', search: '   ', from: '', to: '', servedBy: '' },
      20,
      40
    );
    expect(query).toEqual({ limit: 20, offset: 40 });
    expect(query).not.toHaveProperty('status');
    expect(query).not.toHaveProperty('search');
    expect(query).not.toHaveProperty('from');
  });

  it('includes only the filters that are set, trimming the search', () => {
    const query = salesQueryFrom(
      { status: 'completed', search: '  inv-1 ', from: '', to: '2026-09-01', servedBy: '' },
      50,
      0
    );
    expect(query).toEqual({
      limit: 50,
      offset: 0,
      status: 'completed',
      search: 'inv-1',
      to: '2026-09-01',
    });
  });
});

describe('salesFiltersActive', () => {
  it('is false for the empty filter set', () => {
    expect(salesFiltersActive(EMPTY_SALES_FILTERS)).toBe(false);
  });

  it('is false when the search is only whitespace', () => {
    expect(salesFiltersActive({ ...EMPTY_SALES_FILTERS, search: '   ' })).toBe(false);
  });

  it('is true when any one filter is set', () => {
    expect(salesFiltersActive({ ...EMPTY_SALES_FILTERS, status: 'pending' })).toBe(true);
    expect(salesFiltersActive({ ...EMPTY_SALES_FILTERS, from: '2026-01-01' })).toBe(true);
    expect(salesFiltersActive({ ...EMPTY_SALES_FILTERS, search: 'x' })).toBe(true);
  });
});

describe('validateDateRange', () => {
  it('accepts an open-ended range', () => {
    expect(validateDateRange('', '2026-09-01')).toBeNull();
    expect(validateDateRange('2026-09-01', '')).toBeNull();
    expect(validateDateRange('', '')).toBeNull();
  });

  it('accepts from before or equal to to', () => {
    expect(validateDateRange('2026-09-01', '2026-09-05')).toBeNull();
    expect(validateDateRange('2026-09-01', '2026-09-01')).toBeNull();
  });

  it('refuses from after to', () => {
    expect(validateDateRange('2026-09-05', '2026-09-01')).toMatch(/after the end date/);
  });
});

describe('validateVoidReason', () => {
  it('refuses shorter than the minimum', () => {
    expect(validateVoidReason('no')).toMatch(/at least 3/);
    expect(validateVoidReason('   ')).toMatch(/at least 3/);
  });

  it('accepts a reason within bounds', () => {
    expect(validateVoidReason('Wrong item rung')).toBeNull();
  });

  it('refuses longer than the maximum', () => {
    expect(validateVoidReason('x'.repeat(501))).toMatch(/under 500/);
  });
});

describe('paymentAmountBody', () => {
  it('refuses empty and non-amounts', () => {
    expect(paymentAmountBody('').ok).toBe(false);
    expect(paymentAmountBody('abc').ok).toBe(false);
    expect(paymentAmountBody('12.345').ok).toBe(false);
  });

  it('refuses zero', () => {
    const result = paymentAmountBody('0');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/more than zero/);
  });

  it('normalises a valid amount to a two-decimal string', () => {
    expect(paymentAmountBody('12.5')).toEqual({ ok: true, amount: '12.50', pesewas: 1250 });
  });

  it('handles a whole-cedi amount', () => {
    expect(paymentAmountBody('20')).toEqual({ ok: true, amount: '20.00', pesewas: 2000 });
  });
});

describe('outstandingBalance', () => {
  it('subtracts in pesewas, not floats', () => {
    expect(outstandingBalance('12.50', '5.00')).toBe('7.50');
    // 0.3 - 0.1 is 0.19999999999999998 as floats; pesewas give exactly 0.20.
    expect(outstandingBalance('0.30', '0.10')).toBe('0.20');
  });

  it('floors at zero when the sale is settled or overpaid', () => {
    expect(outstandingBalance('10.00', '10.00')).toBe('0.00');
    expect(outstandingBalance('10.00', '20.00')).toBe('0.00');
  });
});
