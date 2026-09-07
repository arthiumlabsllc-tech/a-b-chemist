/**
 * The payment arithmetic, checked on the cases that matter at a drawer.
 *
 * The figures here are the ones a customer watches: what they still owe, and what
 * comes back into their hand. Both are clamped at zero, and the clamping is the
 * behaviour under test — an overpayment must read as change and never as a
 * negative amount owed, and a part-payment must read as an amount owed and never
 * as negative change. `toCreateSalePayments` is checked on the boundary it owns:
 * pesewas in, decimal strings out, with the drafts that are not really tenders
 * dropped before they can reach the API.
 */

import {
  changeDuePesewas,
  isSettled,
  previewTenders,
  remainingDuePesewas,
  tendersTotalPesewas,
  toCreateSalePayments,
} from '../tender';
import type { TenderDraft } from '../tender';

function cash(amountPesewas: number, reference?: string): TenderDraft {
  return reference === undefined
    ? { method: 'cash', amountPesewas }
    : { method: 'cash', amountPesewas, reference };
}

function momo(amountPesewas: number, reference?: string): TenderDraft {
  return reference === undefined
    ? { method: 'momo', amountPesewas }
    : { method: 'momo', amountPesewas, reference };
}

describe('tendersTotalPesewas', () => {
  it('sums every tender', () => {
    expect(tendersTotalPesewas([cash(2000), momo(1250)])).toBe(3250);
  });

  it('treats a negative draft as nothing rather than subtracting it', () => {
    expect(tendersTotalPesewas([cash(2000), cash(-500)])).toBe(2000);
  });

  it('is zero for no tenders', () => {
    expect(tendersTotalPesewas([])).toBe(0);
  });
});

describe('remainingDuePesewas', () => {
  it('is what is left when the tenders fall short', () => {
    expect(remainingDuePesewas([cash(2000)], 3250)).toBe(1250);
  });

  it('is zero when the tenders exactly cover the total', () => {
    expect(remainingDuePesewas([cash(3250)], 3250)).toBe(0);
  });

  it('is zero, never negative, when the tenders overshoot', () => {
    expect(remainingDuePesewas([cash(5000)], 3250)).toBe(0);
  });
});

describe('changeDuePesewas', () => {
  it('is the overshoot when the tenders exceed the total', () => {
    expect(changeDuePesewas([cash(5000)], 3250)).toBe(1750);
  });

  it('is zero on an exact payment', () => {
    expect(changeDuePesewas([cash(3250)], 3250)).toBe(0);
  });

  it('is zero, never negative, on a part payment', () => {
    expect(changeDuePesewas([cash(2000)], 3250)).toBe(0);
  });

  it('is the overshoot of a split that adds up past the total', () => {
    expect(changeDuePesewas([cash(2000), momo(2000)], 3250)).toBe(750);
  });
});

describe('isSettled', () => {
  it('is true once the tenders cover the total', () => {
    expect(isSettled([cash(3250)], 3250)).toBe(true);
    expect(isSettled([cash(2000), momo(1250)], 3250)).toBe(true);
  });

  it('is false while anything is owed', () => {
    expect(isSettled([cash(2000)], 3250)).toBe(false);
    expect(isSettled([], 3250)).toBe(false);
  });
});

describe('toCreateSalePayments', () => {
  it('writes pesewas as a decimal string of cedis', () => {
    expect(toCreateSalePayments([cash(1250)])).toEqual([{ method: 'cash', amount: '12.50' }]);
    expect(toCreateSalePayments([momo(1)])).toEqual([{ method: 'momo', amount: '0.01' }]);
  });

  it('drops a draft that is not a positive whole number of pesewas', () => {
    // An added-but-unfilled row, and a field caught mid-typing, must not become a
    // payment the backend refuses the whole sale over.
    expect(toCreateSalePayments([cash(0), cash(-100), cash(12.5), cash(2000)])).toEqual([
      { method: 'cash', amount: '20.00' },
    ]);
  });

  it('sends a trimmed cash reference and omits an empty one', () => {
    expect(toCreateSalePayments([cash(500, '  note  ')])).toEqual([
      { method: 'cash', amount: '5.00', reference: 'note' },
    ]);
    expect(toCreateSalePayments([cash(500, '   ')])).toEqual([
      { method: 'cash', amount: '5.00' },
    ]);
  });

  it('never sends a mobile-money reference, because the server mints its own', () => {
    expect(toCreateSalePayments([momo(500, 'customer-typed')])).toEqual([
      { method: 'momo', amount: '5.00' },
    ]);
  });

  it('keeps the tenders in the order they were entered', () => {
    expect(toCreateSalePayments([momo(1000), cash(500)])).toEqual([
      { method: 'momo', amount: '10.00' },
      { method: 'cash', amount: '5.00' },
    ]);
  });
});

describe('previewTenders — the change and fault the server will actually produce', () => {
  it('gives change on a lone cash tender that overpays', () => {
    const preview = previewTenders([cash(5000)], 3250);
    expect({ change: preview.changePesewas, fault: preview.fault, settled: preview.settled }).toEqual({
      change: 1750,
      fault: null,
      settled: true,
    });
  });

  it('gives no change on an exact lone cash tender', () => {
    expect(previewTenders([cash(3250)], 3250).changePesewas).toBe(0);
  });

  it('refuses a mobile-money tender that overshoots, and offers no change', () => {
    const preview = previewTenders([momo(5000)], 3250);
    expect(preview.changePesewas).toBe(0);
    expect(preview.settled).toBe(true);
    expect(preview.fault).toMatch(/mobile money part so they total exactly GHS 32.50/i);
  });

  it('refuses a split that overshoots, even though the raw arithmetic would call the excess change', () => {
    // `changeDuePesewas([cash(2000), momo(2000)], 3250)` is 750; the server takes
    // none of it and refuses the sale. The preview must agree with the server.
    const preview = previewTenders([cash(2000), momo(2000)], 3250);
    expect(preview.changePesewas).toBe(0);
    expect(preview.fault).not.toBeNull();
  });

  it('refuses two cash tenders that overshoot, because change is a single-cash rule', () => {
    const preview = previewTenders([cash(2000), cash(2000)], 3250);
    expect(preview.changePesewas).toBe(0);
    expect(preview.fault).toMatch(/single cash payment/i);
  });

  it('accepts a split that totals exactly, with no change and no fault', () => {
    const preview = previewTenders([cash(2000), momo(1250)], 3250);
    expect({ change: preview.changePesewas, fault: preview.fault, settled: preview.settled }).toEqual({
      change: 0,
      fault: null,
      settled: true,
    });
  });

  it('reports what is still owed on a part payment, without a fault', () => {
    const preview = previewTenders([cash(2000)], 3250);
    expect({ due: preview.duePesewas, settled: preview.settled, fault: preview.fault }).toEqual({
      due: 1250,
      settled: false,
      fault: null,
    });
  });

  it('ignores a draft that is not a whole positive number of pesewas', () => {
    // A row added and not yet filled, and a field caught mid-typing, must not
    // move the change figure or trip the fault.
    const preview = previewTenders([cash(0), cash(12.5), cash(5000)], 3250);
    expect({ tendered: preview.tenderedPesewas, change: preview.changePesewas, fault: preview.fault }).toEqual({
      tendered: 5000,
      change: 1750,
      fault: null,
    });
  });

  it('is empty, owed in full, and faultless with no tenders', () => {
    const preview = previewTenders([], 3250);
    expect({ tendered: preview.tenderedPesewas, due: preview.duePesewas, settled: preview.settled, fault: preview.fault }).toEqual({
      tendered: 0,
      due: 3250,
      settled: false,
      fault: null,
    });
  });
});
