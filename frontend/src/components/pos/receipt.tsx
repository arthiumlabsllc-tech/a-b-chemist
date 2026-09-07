'use client';

/**
 * A receipt, rendered from a stored `SaleDetail`.
 *
 * Presentational on purpose: the POS page wraps it in a modal the moment a sale
 * completes, and `/sales/[id]` renders the same component inline for a reprint or
 * a refund conversation. One receipt layout, two places, no copy of it — the same
 * argument as every other piece in `components/ui`.
 *
 * ## Every figure is the server's, formatted not recomputed
 *
 * The money arrives as decimal strings straight off the sale row and the item
 * rows, and is passed to `Money`, which runs `formatCedis`. Nothing here adds,
 * subtracts or converts: the totals were computed once, in the write path, under
 * the tax settings that applied at the moment of sale, and a receipt that
 * re-derived them on the client could disagree with the row it is describing. The
 * change on this screen is `sales.change_given`, which is the figure the drawer
 * reconciliation will be checked against.
 */

import { Money, Badge } from '@/components/ui/display';
import type { BadgeTone } from '@/components/ui/display';
import { formatDateTime } from '@/lib/format';
import { METHOD_WORD, STATUS_TONE, STATUS_WORD } from './sale-words';
import type { SaleDetail, SaleStatus } from '@/lib/api-types';

/** The status line, worded for whatever state the sale ended in. */
export function SaleStatusBadge({ status }: { status: SaleStatus }) {
  const tone: BadgeTone = STATUS_TONE[status];
  return <Badge tone={tone}>{STATUS_WORD[status]}</Badge>;
}

export function Receipt({ detail }: { detail: SaleDetail }) {
  const { sale, items, payments, servedByName, approvedByName } = detail;
  const awaitingMomo =
    sale.status === 'pending' && payments.some((payment) => payment.method === 'momo');

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-neutral-900">Sale {sale.saleNumber}</p>
          <p className="text-2xs text-neutral-500">{formatDateTime(sale.createdAt)}</p>
        </div>
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

      <ul className="divide-y divide-surface-200 border-y border-surface-200">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate font-medium text-neutral-900">{item.description}</p>
              <p className="text-2xs text-neutral-500">
                {item.quantity} × {item.sellUnit} @ <Money value={item.unitPrice} />
              </p>
            </div>
            <Money value={item.lineTotal} className="shrink-0 font-semibold text-neutral-900" />
          </li>
        ))}
      </ul>

      <dl className="space-y-1">
        <Row label="Subtotal" value={sale.subtotal} />
        {Number(sale.discount) > 0 && (
          <Row label={`Discount${sale.discountReason === null ? '' : ` · ${sale.discountReason}`}`} value={`-${sale.discount}`} />
        )}
        <Row label={`VAT ${sale.vatRate}`} value={sale.vatAmount} muted />
        <Row label={`NHIL ${sale.nhilRate}`} value={sale.nhilAmount} muted />
        <Row label={`GETFund ${sale.getfundRate}`} value={sale.getfundAmount} muted />
        <div className="flex justify-between border-t border-surface-200 pt-2 text-base font-semibold text-neutral-900">
          <dt>Total</dt>
          <dd>
            <Money value={sale.total} />
          </dd>
        </div>
        <Row label="Paid" value={sale.amountPaid} />
        {Number(sale.changeGiven) > 0 && <Row label="Change" value={sale.changeGiven} />}
      </dl>

      <div className="space-y-1 border-t border-surface-200 pt-3">
        <p className="text-2xs font-semibold uppercase tracking-wide text-neutral-500">Payments</p>
        {payments.length === 0 ? (
          <p className="text-2xs text-neutral-500">No payment recorded — the sale is pending.</p>
        ) : (
          <ul className="space-y-1">
            {payments.map((payment) => (
              <li key={payment.id} className="flex items-center justify-between gap-2 text-2xs">
                <span className="text-neutral-700">
                  {METHOD_WORD[payment.method]}
                  <span className="ml-1 text-neutral-400">· {payment.status}</span>
                </span>
                <Money value={payment.amount} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-0.5 border-t border-surface-200 pt-3 text-2xs text-neutral-500">
        <p>Served by {servedByName ?? '—'}</p>
        {approvedByName !== null && <p>Approved by {approvedByName}</p>}
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={['flex justify-between gap-3', muted ? 'text-2xs text-neutral-500' : 'text-neutral-600'].join(' ')}>
      <dt className="min-w-0 truncate">{label}</dt>
      <dd className="shrink-0">
        <Money value={value} />
      </dd>
    </div>
  );
}
