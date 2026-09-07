import { decimalStringFromPesewas } from 'a-and-b-chemist-shared';

import type { SalePaymentMethod, SalePaymentStatus, SaleStatus } from './schema-enums';

/**
 * Settling a sale: what has arrived, what change is owed, and whether the sale is
 * complete.
 *
 * Pure — no database, no clock, no HTTP. That is not tidiness, it is the only way
 * this can be tested against the cases that matter, which are the awkward ones: a
 * lone cash tender that overpays, a split that must not produce change, a mobile
 * money tender that has not arrived yet, a failed tender that has to stop counting
 * toward the ceiling without being erased from the receipt.
 *
 * ## Why the rule lives here and not in a constraint
 *
 * `database/init.sql` says so on the `change_given` column itself: *"Change exists
 * only on a single cash tender. Mobile money cannot give change, so on any sale
 * touching momo this stays zero by rule, enforced in the write path rather than by
 * a constraint that cannot see the tenders."* A check constraint on `sales` sees
 * one row; whether change is legitimate depends on the rows in `sale_payments`
 * beside it. So the rule has to be in code — which means it has to be in *one*
 * piece of code, called by every path that writes a settlement. Create, add a
 * tender, confirm a mobile money charge and answer a webhook all settle a sale,
 * and four copies of this rule is four chances for the till and the webhook to
 * disagree about whether a customer is owed GHS 8.
 *
 * ## The two sums are not the same sum
 *
 * The ceiling — may this basket accept another tender — counts every tender that is
 * still live, including a mobile money one that has not arrived. The settlement —
 * is this sale paid — counts only money that has arrived. Using the settled figure
 * for the ceiling would let a cashier add a second mobile money tender while the
 * first is still in flight, and both would then confirm against a GHS 12 basket.
 * Using the live figure for the settlement would mark a sale complete on a charge
 * the gateway has not confirmed, which is the exact thing the plan forbids trusting.
 */

/**
 * Pesewas as the counter speaks them: `1200` is `'GHS 12.00'`.
 *
 * Exported rather than passed in, so a test asserts the sentence the till really
 * shows. Injecting a formatter would let a test supply its own and pass against
 * wording no operator ever reads.
 *
 * `GHS` and not `GH₵`: the brief writes GHS, and a message that reaches a log file,
 * an SMS or a receipt printer on a device with no cedi sign should not arrive as
 * mojibake. The till renders the symbol where it controls the font.
 */
export function formatCedis(pesewas: number): string {
  return `GHS ${decimalStringFromPesewas(pesewas)}`;
}

/** One tender on a sale, as the settlement rule sees it. */
export interface Tender {
  method: SalePaymentMethod;
  status: SalePaymentStatus;
  /** Pesewas. */
  amount: number;
}

export interface Settlement {
  /** Σ the tenders that have arrived. `sales.amount_paid`. */
  paidPesewas: number;
  /** Non-zero only on a lone cash tender that overpaid. `sales.change_given`. */
  changePesewas: number;
  /** `completed` when what has arrived, less change, covers the total. */
  status: SaleStatus;
}

/**
 * A tender that has neither arrived nor been given back, and so still counts
 * toward what the basket may accept.
 *
 * `failed` and `reversed` are both finished: a failed charge will not arrive, and a
 * reversed one arrived and was handed back — which is what a void does to every
 * tender on the sale it cancels. Counting either toward the ceiling would block a
 * customer from paying for something they have not paid for.
 */
function isLive(tender: Tender): boolean {
  return tender.status !== 'failed' && tender.status !== 'reversed';
}

/**
 * What a sale has actually been paid, and whether it is therefore complete.
 *
 * Never throws on a tender combination: an impossible one is `assertTenders`'s job
 * to refuse before it is written, and this function's job is to answer for whatever
 * rows are actually beside the sale. Keeping the two apart means a settlement read
 * back from the database — including one written by an older version of this rule —
 * produces a number rather than an exception on a page somebody is trying to read.
 */
export function settle(totalPesewas: number, tenders: readonly Tender[]): Settlement {
  const arrived = tenders.filter((tender) => tender.status === 'succeeded');
  const paidPesewas = arrived.reduce((sum, tender) => sum + tender.amount, 0);

  // Change is a property of the whole basket and not of one tender, so it is
  // decided here rather than by whoever happened to take the money.
  //
  // The brief's rule is "change computed only for a single cash tender", and its
  // reason is that a wallet is debited for exactly what it is told to and cannot be
  // given change. So the count that matters is of *live* tenders — the ones that are
  // money or might still become money — and not of every row in `sale_payments`. A
  // declined wallet and a reversed one are records of an attempt, not tenders, and
  // counting them would mean a customer who paid a GHS 20 note for a GHS 12 sale
  // could not be given change because a payment had failed a minute earlier. The
  // workaround for that at a real counter is to void the sale and ring it again,
  // which throws away the receipt trail to solve a problem the rule never meant to
  // create.
  //
  // Two live cash tenders summing past the total are still refused rather than
  // settled as change, because the brief says a single tender and refusing cannot
  // lose money: the operator re-enters the exact figure.
  //
  // The status check is the last of the three conditions and is belt-and-braces. A
  // live tender is not failed or reversed, so the only live status left is
  // `pending`, and a pending cash row could only exist if something wrote one —
  // nothing in this codebase does, because cash is `succeeded` the moment it is
  // recorded. Handing over GHS 8 that was never received is worse than not handing
  // over GHS 8 that was, so the check stays and errs that way.
  const live = tenders.filter(isLive);
  const loneLiveCash =
    live.length === 1 && live[0]?.method === 'cash' && live[0]?.status === 'succeeded';

  const changePesewas =
    loneLiveCash && paidPesewas > totalPesewas ? paidPesewas - totalPesewas : 0;

  const net = paidPesewas - changePesewas;
  return {
    paidPesewas,
    changePesewas,
    status: net >= totalPesewas ? 'completed' : 'pending',
  };
}

/**
 * Why this set of tenders may not be written, or null when it may.
 *
 * A sentence rather than a code, because every one of these is read aloud at a
 * counter by somebody who has to tell a customer what to do differently. The caller
 * wraps it in an `HttpError` and attaches the code.
 *
 * Called with the tenders that will exist *after* the write — the ones already
 * beside the sale plus the one being added — and before anything is written, so a
 * refusal cannot leave a sale half-taken.
 *
 * A tender's `status` is never supplied by a client. The service derives it from
 * the method: cash is `succeeded` the moment it is recorded, because the money is
 * in the drawer or it is not, and mobile money is `pending` until the gateway says
 * otherwise. That is why there is no branch here refusing a pending cash tender —
 * nothing can ask for one.
 */
export function tenderFault(totalPesewas: number, tenders: readonly Tender[]): string | null {
  if (tenders.length === 0) return null;

  for (const tender of tenders) {
    if (tender.amount <= 0) {
      // `sale_payments.amount` carries `check (amount > 0)`. Caught here because a
      // zero tender is not a database problem, it is somebody pressing Enter on an
      // empty amount field, and the constraint's answer would be a 500.
      return 'A payment must be for more than zero.';
    }
  }

  const live = tenders.filter(isLive);
  const liveTotal = live.reduce((sum, tender) => sum + tender.amount, 0);
  if (liveTotal <= totalPesewas) return null;

  const overBy = liveTotal - totalPesewas;

  // The one overpayment the rules allow, and it is allowed for the reason the brief
  // gives rather than as a special case: a lone cash tender is a GHS 20 note handed
  // over for a GHS 12 sale, and the excess is change the drawer owes back.
  if (live.length === 1 && live[0]?.method === 'cash') return null;

  const nonCash = live.filter((tender) => tender.method !== 'cash');

  if (nonCash.length > 0) {
    const nonCashTotal = nonCash.reduce((sum, tender) => sum + tender.amount, 0);
    if (nonCashTotal > totalPesewas) {
      // The wallet alone overshoots. There is no cash figure that fixes this one, so
      // the message must not suggest one.
      return (
        `The mobile money part is ${formatCedis(nonCashTotal)} on a ` +
        `${formatCedis(totalPesewas)} sale. A wallet is debited for exactly what it is ` +
        'told to, and cannot be given change, so it has to be the exact amount or less.'
      );
    }
    // Names the reason and the figure that would work. "Overpaid" on its own invites
    // the operator to try a larger cash amount, which fails the same way.
    return (
      `That is ${formatCedis(overBy)} more than the ${formatCedis(totalPesewas)} due. ` +
      'Mobile money cannot give change, so the cash part has to be entered as exactly ' +
      `${formatCedis(totalPesewas - nonCashTotal)}.`
    );
  }

  // Two or more live cash tenders summing past the total. The brief's rule is a
  // *single* cash tender, so this is refused rather than settled as change — see
  // `settle`'s note on why. Refusing is the direction that cannot lose money: the
  // operator re-enters the exact figure and the sale completes.
  return (
    `That is ${formatCedis(overBy)} more than the ${formatCedis(totalPesewas)} due. ` +
    'Change is only given on a single cash payment, so enter the exact amount.'
  );
}
