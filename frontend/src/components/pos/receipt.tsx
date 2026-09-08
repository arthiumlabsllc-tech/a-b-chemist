'use client';

/**
 * A receipt, rendered from a stored `SaleDetail`.
 *
 * Presentational on purpose: the POS page wraps it in a modal the moment a sale
 * completes, and `/sales/[id]` renders the same component inline for a reprint or
 * a refund conversation. One receipt layout, two places, no copy of it — the same
 * argument as every other piece in `components/ui`.
 *
 * ## It is laid out like the slip it stands for
 *
 * A pharmacy receipt is a narrow thermal slip, so this reads like one: the
 * pharmacy's name and the sale's identity centred at the top, the lines in a tight
 * four-column table, the money right-aligned in tabular figures, and dashed rules
 * where the paper would be torn. The centring and the rules are not decoration —
 * they are what make a customer trust the figure at the bottom, because it looks
 * like the thing they have been handed at every other counter.
 *
 * The slip carries `id="receipt-print-area"`: the print stylesheet in
 * `globals.css` shows only that element when the operator prints, so the page
 * chrome, the modal and the screen-only status notes stay off the paper.
 *
 * ## Every figure is the server's, formatted not recomputed
 *
 * The money arrives as decimal strings straight off the sale row and the item
 * rows, and is passed to `formatMoney`, which only formats. Nothing here adds,
 * subtracts or converts: the totals were computed once, in the write path, under
 * the tax settings that applied at the moment of sale, and a receipt that
 * re-derived them on the client could disagree with the row it is describing. The
 * change on this screen is `sales.change_given`, which is the figure the drawer
 * reconciliation will be checked against.
 */

import { Badge } from '@/components/ui/display';
import type { BadgeTone } from '@/components/ui/display';
import { frontendConfig } from '@/lib/frontend-config';
import { formatDateTime, formatMoney } from '@/lib/format';
import { METHOD_WORD, STATUS_TONE, STATUS_WORD } from './sale-words';
import type { SaleDetail, SaleStatus } from '@/lib/api-types';

/** The status line, worded for whatever state the sale ended in. */
export function SaleStatusBadge({ status }: { status: SaleStatus }) {
  const tone: BadgeTone = STATUS_TONE[status];
  return <Badge tone={tone}>{STATUS_WORD[status]}</Badge>;
}

/** A torn-paper rule between the slip's sections. */
function Tear() {
  return <div aria-hidden="true" className="my-3 border-t border-dashed border-surface-300" />;
}

function SlipRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={[
        'flex justify-between gap-3',
        strong ? 'text-sm font-semibold text-neutral-900' : 'text-2xs text-neutral-600',
      ].join(' ')}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="money shrink-0">{value}</span>
    </div>
  );
}

export function Receipt({ detail }: { detail: SaleDetail }) {
  const { sale, items, batches, payments, servedByName, approvedByName } = detail;
  const awaitingMomo =
    sale.status === 'pending' && payments.some((payment) => payment.method === 'momo');

  // A line can draw from more than one lot; the slip names them under the item the
  // way a dispenser would write them on the back of the box.
  const lotsByItem = new Map<string, string[]>();
  for (const batch of batches) {
    const lots = lotsByItem.get(batch.saleItemId);
    if (lots === undefined) {
      lotsByItem.set(batch.saleItemId, [batch.lotNumber]);
    } else {
      lots.push(batch.lotNumber);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-2xs text-neutral-500">{formatDateTime(sale.createdAt)}</p>
        <SaleStatusBadge status={sale.status} />
      </div>

      {awaitingMomo && (
        <p className="rounded border border-accent-300 bg-accent-50 p-2 text-2xs text-accent-900">
          Awaiting mobile-money confirmation. The sale completes when the payment is confirmed.
        </p>
      )}
      {sale.status === 'voided' && sale.voidReason !== null && (
        <p className="rounded border border-danger-100 bg-danger-50 p-2 text-2xs text-danger-700">
          Voided: {sale.voidReason}
        </p>
      )}

      <div
        id="receipt-print-area"
        className="mx-auto w-full max-w-sm rounded-md border border-surface-200 bg-white px-4 py-5 text-neutral-800"
      >
        <header className="space-y-0.5 text-center">
          <p className="text-base font-bold uppercase tracking-wide text-neutral-900">
            {frontendConfig.appName}
          </p>
          <p className="text-2xs text-neutral-600">
            Receipt {sale.saleNumber} · {formatDateTime(sale.createdAt)}
          </p>
          <p className="text-2xs text-neutral-600">Served by {servedByName ?? '—'}</p>
          {approvedByName !== null && (
            <p className="text-2xs text-neutral-600">Approved by {approvedByName}</p>
          )}
        </header>

        <Tear />

        <table className="w-full text-left text-2xs">
          <thead>
            <tr className="text-neutral-500">
              <th scope="col" className="pb-1 font-medium">
                Item
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Price
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-100">
            {items.map((item) => {
              const lots = lotsByItem.get(item.id);
              return (
                <tr key={item.id} className="align-top">
                  <td className="max-w-0 py-1.5 pr-2">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {item.description}
                    </p>
                    {lots !== undefined && lots.length > 0 && (
                      <p className="truncate text-2xs text-neutral-500">Batch {lots.join(', ')}</p>
                    )}
                  </td>
                  <td className="money whitespace-nowrap py-1.5 text-right text-neutral-600">
                    {item.quantity} {item.sellUnit}
                  </td>
                  <td className="money whitespace-nowrap py-1.5 text-right text-neutral-600">
                    {formatMoney(item.unitPrice)}
                  </td>
                  <td className="money whitespace-nowrap py-1.5 text-right font-semibold text-neutral-900">
                    {formatMoney(item.lineTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <Tear />

        <div className="space-y-1">
          <SlipRow label="Subtotal" value={formatMoney(sale.subtotal)} />
          {Number(sale.discount) > 0 && (
            <SlipRow
              label={`Discount${sale.discountReason === null ? '' : ` · ${sale.discountReason}`}`}
              value={`-${formatMoney(sale.discount)}`}
            />
          )}
          <SlipRow label="Total" value={formatMoney(sale.total)} strong />
        </div>

        <Tear />

        <div className="space-y-1">
          <p className="text-2xs font-semibold uppercase tracking-wide text-neutral-500">
            Tax included in the above
          </p>
          <SlipRow label={`VAT ${sale.vatRate}`} value={formatMoney(sale.vatAmount)} />
          <SlipRow label={`NHIL ${sale.nhilRate}`} value={formatMoney(sale.nhilAmount)} />
          <SlipRow label={`GETFund ${sale.getfundRate}`} value={formatMoney(sale.getfundAmount)} />
          <SlipRow label="Total tax" value={formatMoney(sale.taxTotal)} />
        </div>

        <Tear />

        <div className="space-y-1">
          <p className="text-2xs font-semibold uppercase tracking-wide text-neutral-500">Payments</p>
          {payments.length === 0 ? (
            <p className="text-2xs text-neutral-500">No payment recorded — the sale is pending.</p>
          ) : (
            <ul className="space-y-0.5">
              {payments.map((payment) => (
                <li
                  key={payment.id}
                  className="flex items-center justify-between gap-2 text-2xs text-neutral-600"
                >
                  <span className="min-w-0 truncate">
                    {METHOD_WORD[payment.method]}
                    <span className="text-neutral-400"> · {payment.status}</span>
                  </span>
                  <span className="money shrink-0">{formatMoney(payment.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          <SlipRow label="Amount paid" value={formatMoney(sale.amountPaid)} strong />
          {Number(sale.changeGiven) > 0 && (
            <SlipRow label="Change given" value={formatMoney(sale.changeGiven)} strong />
          )}
        </div>

        <Tear />

        <p className="text-center text-2xs text-neutral-500">Thank you — get well soon.</p>
      </div>
    </div>
  );
}
