/**
 * What an offline sale is allowed to say about money: a total, and no tax split.
 *
 * ## The rule this module exists to keep
 *
 * BRIEF.md §4.5, and it is the honesty rule rather than a mechanic: *never
 * fabricate a tax split offline.* The on-device pricer produces a total and no
 * VAT/NHIL/GETFund breakdown, and the absent split is represented as `null` —
 * never as zero, and never as a figure the till computed itself.
 *
 * ## Why, when the till runs the very same engine the server does
 *
 * `lib/pricing.ts` prices through `priceBasket` from the shared package, so the
 * arithmetic is identical and the split it returns is not wrong. It is still not
 * the till's to show, for two reasons that have nothing to do with arithmetic:
 *
 *  1. **Authority.** The tax on a receipt is a statement to the customer and to
 *     the revenue authority, and the authoritative one is the split the server
 *     computes at write time and snapshots onto the `sales` row. An offline sale
 *     has not been written yet. Its total is a fact about the transaction — the
 *     money the customer handed over — while its split is a claim the server has
 *     not made.
 *  2. **Stale rates.** The till prices from tax settings cached in IndexedDB. The
 *     owner may have changed the rates since. The total the customer pays is
 *     settled at the counter; the split of record is whatever the server derives
 *     when the queued sale replays, from the settings row as it stands then.
 *
 * So offline the receipt shows the total and says the breakdown follows when the
 * sale syncs. Showing a locally-derived split instead would present a provisional
 * figure as the tax of record — a false statement that happens to be computed by
 * the right code.
 *
 * ## Why the type is `null` and not `TaxSplit | null`
 *
 * A field typed `TaxSplit | null` can be filled in by any caller, and the first
 * receipt component that "helpfully" renders `total.taxSplit?.vat ?? 0` has
 * turned the absent split into a zero — the exact fabrication the rule forbids,
 * now invisible because it typechecks. Typing the field as the literal `null`
 * makes filling it a compile error, so the guarantee lives in the type system
 * rather than in everybody remembering the rule.
 */

import type { PricedBasket } from 'a-and-b-chemist-shared';

/**
 * The money an offline sale carries.
 *
 * `totalPesewas` is the amount due, in whole pesewas, exactly as the shared
 * engine computed it — in inclusive mode the shelf price already carried the tax,
 * in exclusive mode the engine added it, and either way this is the figure the
 * customer is asked for at the counter.
 */
export interface OfflineTotal {
  totalPesewas: number;
  /**
   * Always `null`. See the module docstring: the tax breakdown is the server's to
   * state, on the synced receipt, and representing it as anything else offline —
   * a zero, a locally-derived figure — is a false statement to a customer and to
   * GRA. The literal type is the enforcement.
   */
  taxSplit: null;
}

/**
 * Strips a priced basket down to the total an offline sale may show.
 *
 * The input is the same `PricedBasket` the online till uses; this discards every
 * tax field rather than recomputing or re-labelling any of them. It cannot get the
 * split wrong because it never carries one.
 */
export function offlineTotalFromBasket(basket: PricedBasket): OfflineTotal {
  return { totalPesewas: basket.total, taxSplit: null };
}
