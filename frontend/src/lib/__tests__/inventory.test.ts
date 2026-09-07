import { PRODUCT_LIMITS } from '../api-types';
import {
  daysUntilExpiry,
  EMPTY_INVENTORY_FILTERS,
  expiryState,
  EXPIRY_ALERT_WINDOW_DAYS,
  moneyBody,
  optionalText,
  productFiltersActive,
  productQueryFrom,
  quantityBody,
  requiredText,
  stockLevel,
  validateCorrectionNote,
  validateCorrectionReason,
  validateOptionalNote,
  validateOptionalReason,
} from '../inventory';

describe('productQueryFrom', () => {
  it('always carries the page, and nothing else when no filter is set', () => {
    expect(productQueryFrom(EMPTY_INVENTORY_FILTERS, 50, 0)).toEqual({ limit: 50, offset: 0 });
  });

  it('omits an unset filter rather than sending it empty', () => {
    // `buildQuery` drops undefined and null but not '', so the omission has to
    // happen here or the route receives `?search=&category=`.
    const query = productQueryFrom({ search: '', category: '', includeInactive: false }, 20, 40);
    expect(query).toEqual({ limit: 20, offset: 40 });
    expect(query).not.toHaveProperty('search');
    expect(query).not.toHaveProperty('category');
    expect(query).not.toHaveProperty('includeInactive');
  });

  it('trims a set filter and sends includeInactive only when true', () => {
    expect(
      productQueryFrom({ search: '  paracetamol ', category: ' Analgesic ', includeInactive: true }, 50, 0)
    ).toEqual({ limit: 50, offset: 0, search: 'paracetamol', category: 'Analgesic', includeInactive: 'true' });
  });

  it('treats a whitespace-only search as unset', () => {
    expect(productQueryFrom({ search: '   ', category: '', includeInactive: false }, 50, 0)).toEqual({
      limit: 50,
      offset: 0,
    });
  });
});

describe('productFiltersActive', () => {
  it('is false for the empty filters and a whitespace-only search', () => {
    expect(productFiltersActive(EMPTY_INVENTORY_FILTERS)).toBe(false);
    expect(productFiltersActive({ search: '  ', category: '', includeInactive: false })).toBe(false);
  });

  it('is true when any one filter is set', () => {
    expect(productFiltersActive({ search: 'x', category: '', includeInactive: false })).toBe(true);
    expect(productFiltersActive({ search: '', category: 'x', includeInactive: false })).toBe(true);
    expect(productFiltersActive({ search: '', category: '', includeInactive: true })).toBe(true);
  });
});

describe('stockLevel', () => {
  it('is out at zero and below', () => {
    expect(stockLevel(0, 10)).toBe('out');
    expect(stockLevel(-5, 10)).toBe('out');
  });

  it('is low at or under a reorder level that is set', () => {
    expect(stockLevel(10, 10)).toBe('low');
    expect(stockLevel(3, 10)).toBe('low');
  });

  it('is ok above the reorder level', () => {
    expect(stockLevel(11, 10)).toBe('ok');
  });

  it('is never low when no reorder level is set', () => {
    // reorderLevel 0 means "no reorder point", not "everything is low".
    expect(stockLevel(1, 0)).toBe('ok');
    expect(stockLevel(500, 0)).toBe('ok');
  });
});

describe('daysUntilExpiry', () => {
  const today = '2026-09-05';

  it('counts forward to a future date and back to a past one', () => {
    expect(daysUntilExpiry('2026-09-15', today)).toBe(10);
    expect(daysUntilExpiry('2026-08-26', today)).toBe(-10);
  });

  it('is zero on the expiry date itself — the sellable-on-the-day boundary', () => {
    expect(daysUntilExpiry('2026-09-05', today)).toBe(0);
  });

  it('is null for undated stock', () => {
    expect(daysUntilExpiry(null, today)).toBeNull();
  });

  it('refuses a date that does not exist rather than rolling it forward', () => {
    // Date.UTC would make 2026-02-30 into 2 March; the round-trip catches it.
    expect(daysUntilExpiry('2026-02-30', today)).toBeNull();
  });

  it('is null when today is not a real date', () => {
    expect(daysUntilExpiry('2026-09-15', 'not-a-date')).toBeNull();
  });
});

describe('expiryState', () => {
  it('is none for undated stock', () => {
    expect(expiryState(null)).toBe('none');
  });

  it('is expired once the date has passed', () => {
    expect(expiryState(-1)).toBe('expired');
  });

  it('is soon from today to the edge of the window, ok beyond it', () => {
    expect(expiryState(0)).toBe('soon');
    expect(expiryState(EXPIRY_ALERT_WINDOW_DAYS)).toBe('soon');
    expect(expiryState(EXPIRY_ALERT_WINDOW_DAYS + 1)).toBe('ok');
  });
});

describe('quantityBody', () => {
  const max = PRODUCT_LIMITS.quantity.max;

  it('parses a whole number within bounds', () => {
    expect(quantityBody('25', 'how many units arrived', 1, max)).toEqual({ ok: true, quantity: 25 });
    expect(quantityBody(' 7 ', 'how many units arrived', 1, max)).toEqual({ ok: true, quantity: 7 });
  });

  it('refuses empty, a fraction and a non-number', () => {
    expect(quantityBody('', 'how many units arrived', 1, max).ok).toBe(false);
    expect(quantityBody('1.5', 'how many units arrived', 1, max)).toEqual({
      ok: false,
      message: 'Enter how many units arrived as a whole number',
    });
    expect(quantityBody('abc', 'how many units arrived', 1, max).ok).toBe(false);
  });

  it('refuses below the minimum, which is what stops a receive of zero', () => {
    expect(quantityBody('0', 'how many units arrived', 1, max)).toEqual({
      ok: false,
      message: 'Enter 1 or more',
    });
  });

  it('allows zero for an adjustment, whose minimum is zero', () => {
    expect(quantityBody('0', 'the counted quantity', 0, max)).toEqual({ ok: true, quantity: 0 });
  });

  it('refuses above the maximum', () => {
    expect(quantityBody(String(max + 1), 'how many units arrived', 1, max)).toEqual({
      ok: false,
      message: `Enter ${max} or fewer`,
    });
  });
});

describe('moneyBody', () => {
  it('normalises to a two-decimal string', () => {
    expect(moneyBody('12.50', 'the cost price')).toEqual({ ok: true, amount: '12.50' });
    expect(moneyBody('12.5', 'the cost price')).toEqual({ ok: true, amount: '12.50' });
    expect(moneyBody(' 8 ', 'the cost price')).toEqual({ ok: true, amount: '8.00' });
  });

  it('allows zero, unlike a payment amount', () => {
    expect(moneyBody('0', 'the cost price')).toEqual({ ok: true, amount: '0.00' });
  });

  it('refuses anything that is not a bounded amount', () => {
    expect(moneyBody('', 'the cost price').ok).toBe(false);
    expect(moneyBody('abc', 'the cost price').ok).toBe(false);
    expect(moneyBody('1.234', 'the cost price').ok).toBe(false);
  });
});

describe('text validators', () => {
  it('requiredText refuses empty and over-long, and trims', () => {
    expect(requiredText('', 'a product name', 200)).toBe('Enter a product name');
    expect(requiredText('   ', 'a product name', 200)).toBe('Enter a product name');
    expect(requiredText('x'.repeat(201), 'a product name', 200)).toBe(
      'Keep a product name under 200 characters'
    );
    expect(requiredText('  Paracetamol  ', 'a product name', 200)).toBeNull();
  });

  it('optionalText passes empty but bounds a value', () => {
    expect(optionalText('', 'the category', 100)).toBeNull();
    expect(optionalText('x'.repeat(101), 'the category', 100)).toBe(
      'Keep the category under 100 characters'
    );
    expect(optionalText('Analgesic', 'the category', 100)).toBeNull();
  });
});

describe('correction validators', () => {
  it('validateCorrectionReason needs a real reason', () => {
    expect(validateCorrectionReason('ab')).toBe(
      `Give at least ${PRODUCT_LIMITS.reason.min} characters — this is the audit trail for the correction`
    );
    expect(validateCorrectionReason('abc')).toBeNull();
    expect(validateCorrectionReason('x'.repeat(201))).toBe(
      `Keep the reason under ${PRODUCT_LIMITS.reason.max} characters`
    );
  });

  it('validateCorrectionNote needs at least one character', () => {
    expect(validateCorrectionNote('')).toBe('Describe what was counted or what happened');
    expect(validateCorrectionNote('   ')).toBe('Describe what was counted or what happened');
    expect(validateCorrectionNote('Counted 12, shelf held 10')).toBeNull();
    expect(validateCorrectionNote('x'.repeat(501))).toBe(
      `Keep the note under ${PRODUCT_LIMITS.note.max} characters`
    );
  });

  it('validateOptionalReason passes empty but holds a value to the rule', () => {
    expect(validateOptionalReason('')).toBeNull();
    expect(validateOptionalReason('ab')).not.toBeNull();
    expect(validateOptionalReason('Damaged in transit')).toBeNull();
  });

  it('validateOptionalNote passes empty but bounds a value', () => {
    expect(validateOptionalNote('')).toBeNull();
    expect(validateOptionalNote('x'.repeat(501))).toBe(
      `Keep the note under ${PRODUCT_LIMITS.note.max} characters`
    );
  });
});
