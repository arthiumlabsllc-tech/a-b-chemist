'use client';

/**
 * What the till shows instead of a receipt when it could not reach the server.
 *
 * ## Why this is not `Receipt` with a banner on it
 *
 * `Receipt` renders a `SaleDetail` — a sale number, a status, a server-computed
 * tax breakdown, the lots drawn, who served and who approved. Offline there is
 * none of that, and the honest way to have none of it is not to render the
 * component and blank the fields: a `SaleDetail` built on the device would need a
 * sale number invented and a tax split fabricated, which is BRIEF.md §4.5's
 * prohibition arrived at from the other end. So this shows only what is true at
 * the counter — the lines, the money handed over, the change counted back — and
 * says plainly that the server has not recorded any of it.
 *
 * ## The sentence that has to be here
 *
 * The drawer is holding cash that no report knows about. Until this sale syncs it
 * is not in Sales, not in the takings and the stock has not moved, so a shift
 * counted against the day's figures would come up short by exactly this amount and
 * nobody would know why. That gap is the real cost of trading through an outage,
 * and hiding it behind a receipt that looks like the online one is how a pharmacy
 * ends up reconciling at the end of the month instead of at the end of the day.
 */

import Link from 'next/link';

import { WarningNotice } from '@/components/ui/display';
import { cediText } from '@/lib/pricing';
import type { BasketLine } from '@/lib/pricing';
import type { TenderDraft } from '@/lib/tender';
import { METHOD_WORD } from './sale-words';

export interface ProvisionalReceiptProps {
  lines: readonly BasketLine[];
  /** What the customer was asked for, priced on this device. */
  totalPesewas: number;
  tenders: readonly TenderDraft[];
  /** What was counted back into the customer's hand. */
  changePesewas: number;
}

export function ProvisionalReceipt({
  lines,
  totalPesewas,
  tenders,
  changePesewas,
}: ProvisionalReceiptProps) {
  return (
    <div className="space-y-3">
      <WarningNotice>
        Not recorded on the server. This sale is held on this device and will be sent when the
        connection returns — you can retry or discard it on{' '}
        <Link href="/sync" className="font-semibold underline">
          Sync
        </Link>
        .
      </WarningNotice>

      <ul className="divide-y divide-surface-200 rounded-lg border border-surface-200">
        {lines.map((line) => (
          <li key={line.lineId} className="flex items-baseline justify-between gap-3 px-3 py-2">
            <span className="min-w-0 truncate text-sm text-neutral-900">{line.name}</span>
            <span className="shrink-0 text-2xs text-neutral-500">
              {line.quantity} {line.sellUnit}
            </span>
          </li>
        ))}
      </ul>

      <dl className="space-y-1 text-sm">
        <div className="flex justify-between border-t border-surface-200 pt-2 text-base font-semibold text-neutral-900">
          <dt>Total</dt>
          <dd className="money">{cediText(totalPesewas)}</dd>
        </div>
        {tenders.map((tender, index) => (
          <div key={`${tender.method}-${index}`} className="flex justify-between text-neutral-600">
            <dt>
              {METHOD_WORD[tender.method]}
              {tender.reference === undefined || tender.reference === ''
                ? ''
                : ` · ${tender.reference}`}
            </dt>
            <dd className="money">{cediText(tender.amountPesewas)}</dd>
          </div>
        ))}
        {changePesewas > 0 && (
          <div className="flex justify-between font-semibold text-neutral-900">
            <dt>Change given</dt>
            <dd className="money">{cediText(changePesewas)}</dd>
          </div>
        )}
      </dl>

      <p className="text-2xs text-neutral-500">
        The cash is in the drawer, but until this is recorded the sale is not in Sales, the takings
        for the day do not include it, and stock has not been deducted. There is no tax breakdown
        yet: the server computes VAT, NHIL and GETFund when it records the sale, and a figure this
        device derived would not be the one on the receipt of record.
      </p>
    </div>
  );
}
