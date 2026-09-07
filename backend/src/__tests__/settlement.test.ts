import { formatCedis, settle, tenderFault } from '../utils/settlement';
import type { Tender } from '../utils/settlement';
import type { SalePaymentMethod, SalePaymentStatus } from '../utils/schema-enums';

/**
 * The settlement rule: what has arrived, what change is owed, and whether the sale
 * is complete.
 *
 * The running example is the brief's own shape of sale — GHS 12.00 due, part cash
 * and part mobile money — because every interesting case is a variation on it.
 *
 * What these tests are really pinning is that the two sums in `settlement.ts` stay
 * two sums. The ceiling counts a mobile money tender that has not arrived yet; the
 * settlement does not. Collapse them and either a customer can be charged twice for
 * one basket or a sale is marked complete on a charge the gateway never confirmed.
 */

/** GHS 12.00. */
const TOTAL = 1_200;

function tender(
  method: SalePaymentMethod,
  status: SalePaymentStatus,
  amount: number
): Tender {
  return { method, status, amount };
}

const cash = (amount: number): Tender => tender('cash', 'succeeded', amount);
const momoPending = (amount: number): Tender => tender('momo', 'pending', amount);
const momoArrived = (amount: number): Tender => tender('momo', 'succeeded', amount);
const momoFailed = (amount: number): Tender => tender('momo', 'failed', amount);

describe('formatCedis', () => {
  it('reads as the counter does, to the pesewa', () => {
    expect(formatCedis(1_200)).toBe('GHS 12.00');
    expect(formatCedis(55)).toBe('GHS 0.55');
    expect(formatCedis(0)).toBe('GHS 0.00');
    expect(formatCedis(999_999_99)).toBe('GHS 999999.99');
  });
});

describe('settle', () => {
  it('leaves an untendered sale pending with nothing paid', () => {
    expect(settle(TOTAL, [])).toEqual({ paidPesewas: 0, changePesewas: 0, status: 'pending' });
  });

  it('completes on a lone cash tender for exactly the total, with no change', () => {
    expect(settle(TOTAL, [cash(TOTAL)])).toEqual({
      paidPesewas: 1_200,
      changePesewas: 0,
      status: 'completed',
    });
  });

  it('owes the excess as change on a lone cash tender that overpays', () => {
    // A GHS 20 note for a GHS 12 sale. The one case the brief allows change for.
    expect(settle(TOTAL, [cash(2_000)])).toEqual({
      paidPesewas: 2_000,
      changePesewas: 800,
      status: 'completed',
    });
  });

  it('leaves the sale pending on a lone cash tender that underpays', () => {
    expect(settle(TOTAL, [cash(1_000)])).toEqual({
      paidPesewas: 1_000,
      changePesewas: 0,
      status: 'pending',
    });
  });

  it('pays nothing on a mobile money tender that has not arrived', () => {
    expect(settle(TOTAL, [momoPending(TOTAL)])).toEqual({
      paidPesewas: 0,
      changePesewas: 0,
      status: 'pending',
    });
  });

  it('completes the same mobile money tender once it has arrived', () => {
    // The only difference from the test above is the status, which is the point: a
    // charge is believed when the gateway confirms it and not before.
    expect(settle(TOTAL, [momoArrived(TOTAL)])).toEqual({
      paidPesewas: 1_200,
      changePesewas: 0,
      status: 'completed',
    });
  });

  it('completes a split that exactly covers the total, and gives no change', () => {
    expect(settle(TOTAL, [cash(500), momoArrived(700)])).toEqual({
      paidPesewas: 1_200,
      changePesewas: 0,
      status: 'completed',
    });
  });

  it('gives no change on a split even when the cash part overpaid', () => {
    // Unreachable through the write path — `tenderFault` refuses it below — and
    // asserted anyway because `settle` also reads rows back from the database. Its
    // answer for an impossible basket has to be the safe one: report what arrived,
    // invent no change, and leave the GHS 5.00 visible on the receipt where an audit
    // can see it rather than silently handing it back.
    expect(settle(TOTAL, [momoArrived(700), cash(1_000)])).toEqual({
      paidPesewas: 1_700,
      changePesewas: 0,
      status: 'completed',
    });
  });

  it('pays nothing on a failed tender', () => {
    expect(settle(TOTAL, [momoFailed(TOTAL)])).toEqual({
      paidPesewas: 0,
      changePesewas: 0,
      status: 'pending',
    });
  });

  it('pays nothing on reversed tenders, which is what a void leaves behind', () => {
    // A void reverses every tender on the sale, so the money has gone back. Reading
    // that as paid would leave a cancelled sale showing as settled.
    expect(settle(TOTAL, [tender('cash', 'reversed', 2_000)])).toEqual({
      paidPesewas: 0,
      changePesewas: 0,
      status: 'pending',
    });
  });

  it('completes two cash tenders that together cover the total exactly', () => {
    expect(settle(TOTAL, [cash(700), cash(500)])).toEqual({
      paidPesewas: 1_200,
      changePesewas: 0,
      status: 'completed',
    });
  });

  it('counts a succeeded tender beside a failed one', () => {
    // A wallet that declined and then cash at the counter. The failed tender stays
    // on the receipt — it is a record of what was tried — but it pays nothing.
    expect(settle(TOTAL, [momoFailed(TOTAL), cash(TOTAL)])).toEqual({
      paidPesewas: 1_200,
      changePesewas: 0,
      status: 'completed',
    });
  });

  it('gives change on a cash note after a declined wallet', () => {
    // The case the literal reading of "a single cash tender" gets wrong. Only one
    // tender here is money: the wallet declined, so it is a record of an attempt and
    // not something that could have been given change anyway. Refusing the GHS 8.00
    // would send the operator to void the sale and ring it again, losing the receipt
    // trail to satisfy a rule whose stated reason is only that a wallet cannot give
    // change.
    expect(settle(TOTAL, [momoFailed(TOTAL), cash(2_000)])).toEqual({
      paidPesewas: 2_000,
      changePesewas: 800,
      status: 'completed',
    });
  });

  it('gives no change while a wallet tender is still in flight beside the cash', () => {
    // The other side of the same distinction: a *pending* wallet tender is live, so
    // this is not a lone cash tender, so no change — and the cash on its own does not
    // cover the sale, so it stays pending until the wallet answers.
    expect(settle(TOTAL, [momoPending(700), cash(1_000)])).toEqual({
      paidPesewas: 1_000,
      changePesewas: 0,
      status: 'pending',
    });
  });
});

describe('tenderFault', () => {
  it('finds no fault with an untendered sale', () => {
    // A customer who cannot pay leaves the sale pending with the stock already
    // drawn, which is the brief's answer to there being no credit tender.
    expect(tenderFault(TOTAL, [])).toBeNull();
  });

  it('refuses a zero tender before the column does', () => {
    expect(tenderFault(TOTAL, [cash(0)])).toBe('A payment must be for more than zero.');
  });

  it('refuses a negative tender, which would be money leaving the drawer', () => {
    expect(tenderFault(TOTAL, [cash(-500)])).toBe('A payment must be for more than zero.');
  });

  it('allows a lone cash tender to exceed the total, because the excess is change', () => {
    expect(tenderFault(TOTAL, [cash(2_000)])).toBeNull();
  });

  it('refuses a lone mobile money tender that exceeds the total', () => {
    // There is no cash figure that fixes this one, so the message must not suggest
    // one — it says the wallet has to be charged the exact amount or less.
    expect(tenderFault(TOTAL, [momoArrived(1_500)])).toBe(
      'The mobile money part is GHS 15.00 on a GHS 12.00 sale. A wallet is debited for ' +
        'exactly what it is told to, and cannot be given change, so it has to be the exact ' +
        'amount or less.'
    );
  });

  it('says what the exact cash figure is when mobile money is part of the sale', () => {
    // GHS 7.00 on the wallet, so the cash part has to be GHS 5.00 and the operator
    // is told that rather than being told only that GHS 10.00 was too much.
    expect(tenderFault(TOTAL, [momoPending(700), cash(1_000)])).toBe(
      'That is GHS 5.00 more than the GHS 12.00 due. Mobile money cannot give change, so ' +
        'the cash part has to be entered as exactly GHS 5.00.'
    );
  });

  it('refuses two cash tenders that exceed the total', () => {
    // The brief's rule is a *single* cash tender. Refusing is the direction that
    // cannot lose money: the operator re-enters the exact figure.
    expect(tenderFault(TOTAL, [cash(700), cash(1_000)])).toBe(
      'That is GHS 5.00 more than the GHS 12.00 due. Change is only given on a single cash ' +
        'payment, so enter the exact amount.'
    );
  });

  it('stops counting a failed tender toward the ceiling', () => {
    // The wallet declined, so the customer pays cash instead. Counting the dead
    // tender would refuse a payment for something that has not been paid for.
    expect(tenderFault(TOTAL, [momoFailed(TOTAL), cash(TOTAL)])).toBeNull();
  });

  it('stops counting a reversed tender toward the ceiling', () => {
    expect(tenderFault(TOTAL, [tender('cash', 'reversed', 2_000), cash(TOTAL)])).toBeNull();
  });

  it('still counts a pending mobile money tender toward the ceiling', () => {
    // The other half of the two-sums rule, and the one that stops a double charge: a
    // wallet tender in flight has not arrived, so it settles nothing, but it is live,
    // so the basket cannot accept more money against it. The exact cash figure the
    // message lands on is zero, which is the true answer — the wallet already covers
    // the sale and no cash is needed at all.
    expect(tenderFault(TOTAL, [momoPending(TOTAL), cash(500)])).toBe(
      'That is GHS 5.00 more than the GHS 12.00 due. Mobile money cannot give change, so ' +
        'the cash part has to be entered as exactly GHS 0.00.'
    );
  });
});
