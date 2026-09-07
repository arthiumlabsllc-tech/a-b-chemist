import type { CreateSaleBody } from '../../api-types';
import type { BasketLine } from '../../pricing';
import { offlineSaleBlocker, queuedSaleDraft, saleSummary } from '../till';
import type { OfflineTotal } from '../offline-pricing';

/**
 * The three refusals and one construction the offline till depends on.
 *
 * The blocker tests are the ones to read before changing `offlineSaleBlocker`: the
 * rule is not a preference, it is the only branch that does not end with a
 * prescription-only medicine out of the door and a sale the server will refuse on
 * replay. `sales.service.ts` throws `prescription_needs_approver` for exactly that
 * body, so a test here that let an Rx basket through would be a test agreeing with
 * a 400.
 */

function line(overrides: Partial<BasketLine> = {}): BasketLine {
  return {
    lineId: 'p-1:single',
    productId: 'p-1',
    name: 'Paracetamol 500mg',
    code: 'PARA-500',
    quantity: 2,
    sellUnit: 'single',
    packSize: 1,
    baseUnitPrice: '0.50',
    vatTreatment: 'standard',
    requiresPrescription: false,
    ...overrides,
  };
}

const TOTAL: OfflineTotal = { totalPesewas: 1000, taxSplit: null };

describe('offlineSaleBlocker', () => {
  it('lets an ordinary basket through', () => {
    expect(offlineSaleBlocker([line(), line({ lineId: 'p-2:single' })])).toBeNull();
  });

  it('lets an empty basket through, because there is nothing in it to approve', () => {
    expect(offlineSaleBlocker([])).toBeNull();
  });

  it('refuses a prescription-only line and names it', () => {
    const blocker = offlineSaleBlocker([
      line(),
      line({ lineId: 'p-9:pack', productId: 'p-9', name: 'Amoxicillin 500mg', requiresPrescription: true }),
    ]);

    expect(blocker).not.toBeNull();
    // The name is the point. The operator has to be able to find the line to take
    // it off, and "a prescription-only item" makes them search the basket for the
    // one thing the till already knew.
    expect(blocker).toContain('Amoxicillin 500mg');
    // And the remedy, so a refusal is an instruction rather than a dead end.
    expect(blocker).toContain('Take it off this basket');
  });

  it('names every prescription-only line, not just the first', () => {
    const blocker = offlineSaleBlocker([
      line({ lineId: 'p-9:pack', productId: 'p-9', name: 'Amoxicillin 500mg', requiresPrescription: true }),
      line({ lineId: 'p-8:single', productId: 'p-8', name: 'Codeine syrup', requiresPrescription: true }),
    ]);

    expect(blocker).toContain('Amoxicillin 500mg');
    expect(blocker).toContain('Codeine syrup');
  });

  it('does not blame the lines that could have been sold', () => {
    const blocker = offlineSaleBlocker([
      line({ lineId: 'p-9:pack', productId: 'p-9', name: 'Amoxicillin 500mg', requiresPrescription: true }),
    ]);

    expect(blocker).not.toContain('Paracetamol');
  });
});

describe('saleSummary', () => {
  it('labels a one-line sale with the product and the quantity', () => {
    expect(saleSummary([line()])).toBe('Paracetamol 500mg \u00d7 2');
  });

  it('says how many more lines there are, and keeps the singular', () => {
    expect(saleSummary([line(), line({ lineId: 'p-2:single' })])).toBe(
      'Paracetamol 500mg \u00d7 2 + 1 more line'
    );
    expect(
      saleSummary([line(), line({ lineId: 'p-2:single' }), line({ lineId: 'p-3:single' })])
    ).toBe('Paracetamol 500mg \u00d7 2 + 2 more lines');
  });

  it('answers for an empty basket rather than rendering undefined', () => {
    expect(saleSummary([])).toBe('An empty basket');
  });
});

describe('queuedSaleDraft', () => {
  const body: CreateSaleBody = {
    lines: [{ productId: 'p-1', quantity: 2, sellUnit: 'single' }],
    clientSaleId: 'sale-1',
    payments: [{ method: 'cash', amount: '10.00' }],
  };

  it('carries the idempotency key onto the queued sale', () => {
    const draft = queuedSaleDraft({ body, lines: [line()], provisional: TOTAL });

    expect(draft?.sale.clientSaleId).toBe('sale-1');
  });

  it('replays the body verbatim, tenders and all', () => {
    const draft = queuedSaleDraft({ body, lines: [line()], provisional: TOTAL });

    // Verbatim is the safety property: the queue stores the request the till built
    // and posts it again unchanged, so anything dropped here is money the server
    // will never hear about.
    expect(draft?.sale.payments).toEqual([{ method: 'cash', amount: '10.00' }]);
    expect(draft?.sale.lines).toEqual([{ productId: 'p-1', quantity: 2, sellUnit: 'single' }]);
  });

  it('counts lines, not selling units', () => {
    const draft = queuedSaleDraft({
      body,
      lines: [line({ quantity: 5 }), line({ lineId: 'p-2:single', quantity: 3 })],
      provisional: TOTAL,
    });

    // Two lines and eight units. `/sync` prints "{lineCount} lines", so counting
    // units there would read "8 lines" over a basket of two.
    expect(draft?.lineCount).toBe(2);
  });

  it('labels the draft with the same summary the list will show', () => {
    const lines = [line(), line({ lineId: 'p-2:single' })];
    const draft = queuedSaleDraft({ body, lines, provisional: TOTAL });

    expect(draft?.summary).toBe(saleSummary(lines));
  });

  it('passes the offline money through with its split still absent', () => {
    const draft = queuedSaleDraft({ body, lines: [line()], provisional: TOTAL });

    expect(draft?.provisional).toEqual({ totalPesewas: 1000, taxSplit: null });
  });

  it('refuses a body with no clientSaleId, so it cannot be queued as a duplicate', () => {
    const { clientSaleId: _ignored, ...unkeyed } = body;

    // The one sale that must never reach the queue. Without the key a replay is a
    // second sale rather than a retry, and there is nothing on the server to
    // recognise it by — so the answer is null, and the till has to say the sale is
    // not held anywhere instead of showing a receipt that claims it is.
    expect(queuedSaleDraft({ body: unkeyed, lines: [line()], provisional: TOTAL })).toBeNull();
  });
});
