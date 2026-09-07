'use client';

/**
 * A recall trace, rendered. Read-only: `GET /inventory/:id/batches/:batchId/recall`
 * answers who a recalled lot reached and the page shows this in a dialog.
 *
 * The point of a recall is the contact list, so it leads. The sales behind it
 * follow, each linking to its sale, and the untraceable walk-ins are named last
 * and plainly — a recall that quietly dropped the sales it could not attribute
 * would be worse than one that says how many it could not reach.
 */

import Link from 'next/link';

import { SaleStatusBadge } from '@/components/pos/receipt';
import { EmptyState, Money, StatusNotice, WarningNotice } from '@/components/ui/display';
import type { RecallResult } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';

export function RecallPanel({ recall }: { recall: RecallResult }) {
  const { batch, sales, contacts, untraceableSales } = recall;
  const traced = sales.length;

  return (
    <div className="space-y-5">
      <StatusNotice>
        Lot <span className="font-semibold">{batch.lotNumber}</span> drew from {traced}{' '}
        {traced === 1 ? 'sale' : 'sales'}
        {contacts.length > 0 &&
          `, reaching ${contacts.length} ${contacts.length === 1 ? 'person' : 'people'}`}
        {untraceableSales > 0 &&
          `, and ${untraceableSales} could not be traced to a ${untraceableSales === 1 ? 'person' : 'people'}`}
        .
      </StatusNotice>

      {contacts.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-neutral-800">People to contact</h3>
          <ul className="mt-2 divide-y divide-surface-200 rounded-md border border-surface-200">
            {contacts.map((contact) => (
              <li key={`${contact.name}-${contact.phone ?? 'no-phone'}`} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-900">{contact.name}</p>
                  <p className="text-2xs text-neutral-600">
                    {contact.phone === null ? 'No phone number on the sale' : contact.phone}
                  </p>
                </div>
                <span className="shrink-0 text-2xs text-neutral-600">
                  {contact.sales} {contact.sales === 1 ? 'sale' : 'sales'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="text-sm font-semibold text-neutral-800">Sales from this lot</h3>
        {sales.length === 0 ? (
          <EmptyState
            title="No sales drew from this lot"
            message="Nothing was sold from it, so there is nobody to trace."
          />
        ) : (
          <ul className="mt-2 divide-y divide-surface-200 rounded-md border border-surface-200">
            {sales.map((sale) => (
              <li key={sale.saleId} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/sales/${sale.saleId}`}
                    className="text-sm font-medium text-primary-700 underline-offset-2 hover:underline"
                  >
                    {sale.saleNumber}
                  </Link>
                  <SaleStatusBadge status={sale.status} />
                </div>
                <p className="mt-1 text-2xs text-neutral-600">
                  {formatDateTime(sale.soldAt)} · {sale.units} {sale.sellUnit} · {sale.description} ·
                  served by {sale.servedBy} · <Money value={sale.unitCost} /> unit cost
                </p>
                {sale.patientName !== null && (
                  <p className="mt-0.5 text-2xs text-neutral-700">
                    Patient: {sale.patientName}
                    {sale.patientPhone !== null ? ` · ${sale.patientPhone}` : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {untraceableSales > 0 && (
        <WarningNotice>
          {untraceableSales} {untraceableSales === 1 ? 'sale was' : 'sales were'} walk-ins with no
          patient recorded, so nobody can be contacted for {untraceableSales === 1 ? 'it' : 'them'}.
          A notice at the counter is the only way to reach these customers.
        </WarningNotice>
      )}
    </div>
  );
}
