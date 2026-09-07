/**
 * The words the reports page renders, in one place.
 *
 * Same split as `components/pos/sale-words.ts`: the maps live beside the
 * components rather than in `lib` because they are presentation vocabulary, and
 * any tone added here would be a `BadgeTone` — a component type — while `lib`
 * holds no Tailwind and no component imports. Each map is a total `Record` over
 * its union, so a preset added to `REPORT_PRESETS` or a treatment added to
 * `VAT_TREATMENTS` without a word here is a compile error rather than a blank
 * cell.
 *
 * The status, tender and role vocabularies are *not* repeated here. They belong to
 * `components/pos/sale-words.ts`, `components/inventory/inventory-words.ts` and
 * `lib/navigation.ts` respectively, and the reports page imports them: a report is
 * the document the owner reads beside the till it summarises, and a status the
 * receipt calls "Partly refunded" while the report calls it "Partial" is two
 * vocabularies for one row of the same day's trading.
 */

import type { VatTreatment } from '@/lib/api-types';
import type { ReportPreset } from '@/lib/reports';

/** The shortcut buttons beside the date inputs. */
export const PRESET_WORD: Record<ReportPreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  thisMonth: 'This month',
  lastMonth: 'Last month',
};

/**
 * What each VAT row means for a return, under the row.
 *
 * The `exempt` and `zero_rated` notes are the reason this map exists rather than
 * the table standing alone. The two produce *identical* numbers — the shared
 * engine's `zeroSplit` gives both a base and nothing owed — and the only thing
 * that separates them on a return is whether the input tax behind the supply is
 * recoverable. A reader who sees two rows of zeros and concludes they are the same
 * thing puts zero-rated turnover in the exempt box and loses A&B the input credit
 * on it, which is exactly the mistake `shared/src/tax.ts` says a report must not
 * invite.
 */
export const TREATMENT_NOTE: Record<VatTreatment, string> = {
  standard: 'Charged at the rates in force when each sale was made, not at the rates in force now.',
  exempt: 'No VAT, NHIL or GETFund. Input tax on these purchases is not recoverable.',
  zero_rated: 'Taxable at zero. Input tax on these purchases is still recoverable.',
};

/**
 * What "not settled" covers in the tender table.
 *
 * Spelled out because it is not the same as "pending": the API counts a charge
 * that has not *succeeded*, so a failed or reversed mobile-money charge sits here
 * too. A column headed "Pending" over money that has failed reads as money still
 * arriving, and an owner waiting for it is waiting for something that will not
 * come.
 */
export const UNSETTLED_NOTE =
  'Not settled counts a charge that has not succeeded — still settling, failed or reversed.';
