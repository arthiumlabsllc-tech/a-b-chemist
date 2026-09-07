'use client';

/**
 * Sales history. `/sales`, gated by `sales:read`.
 *
 * The list the back office works from: every sale, newest first, filterable by
 * status, sale number and date range. Each row is a link to `/sales/[id]`, which
 * renders the receipt and the actions a sale can still take. This page reads and
 * navigates and writes nothing — voiding and adding a payment happen on the detail
 * page, where the operator is looking at the sale they are changing.
 *
 * ## The fetch is debounced, not fired per keystroke
 *
 * The search box drives the same effect as every other filter, and a request on
 * every character would hammer a route that shares its IP rate-limit bucket with
 * the whole pharmacy behind one NAT. A 250ms settle coalesces typing into one
 * query without a separate "Apply" button to remember to press. The effect cancels
 * an in-flight response when the filters move again, so a slow answer to an old
 * query cannot land on top of a newer one.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { SaleStatusBadge } from '@/components/pos/receipt';
import { METHOD_WORD, STATUS_WORD } from '@/components/pos/sale-words';
import { Button } from '@/components/ui/button';
import {
  Card,
  EmptyState,
  ErrorNotice,
  Money,
  PageHeader,
  Spinner,
} from '@/components/ui/display';
import { Field, Input, Select } from '@/components/ui/field';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import { SALE_STATUSES } from '@/lib/api-types';
import type { SaleListItem, SaleStatus, SalesListResponse } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import {
  EMPTY_SALES_FILTERS,
  salesFiltersActive,
  salesQueryFrom,
  validateDateRange,
  type SalesFilters,
} from '@/lib/sales';

/** The backend's own `DEFAULT_LIST_LIMIT`, so a page is one server page. */
const PAGE_SIZE = 50;

export default function SalesPage() {
  const { api } = useAuth();

  const [filters, setFilters] = useState<SalesFilters>(EMPTY_SALES_FILTERS);
  const [offset, setOffset] = useState(0);
  const [sales, setSales] = useState<SaleListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const dateError = validateDateRange(filters.from, filters.to);
  const filtersActive = salesFiltersActive(filters);

  useEffect(() => {
    // A backwards range matches nothing; say so rather than show an empty list
    // that reads as "no sales". The results already on screen are left alone.
    if (dateError !== null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setLoadError(null);
        try {
          const result = await api.get<SalesListResponse>('/sales', {
            query: salesQueryFrom(filters, PAGE_SIZE, offset),
          });
          if (cancelled) return;
          setSales(result.sales);
          // No total count comes back, so a full page is the only signal there
          // might be another. The last page being exactly full costs one extra
          // empty fetch, which is cheaper than a COUNT on every list.
          setHasMore(result.sales.length === PAGE_SIZE);
        } catch (error) {
          if (!cancelled) {
            setLoadError(apiErrorMessage(error, 'Could not load the sales history.'));
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [api, filters, offset, reloadToken, dateError]);

  function update(patch: Partial<SalesFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  }

  function clearFilters() {
    setFilters(EMPTY_SALES_FILTERS);
    setOffset(0);
  }

  return (
    <div>
      <PageHeader title="Sales" subtitle="Every sale, newest first" />

      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        <Card>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Search" htmlFor="sales-search">
              <Input
                id="sales-search"
                placeholder="Sale number"
                autoComplete="off"
                value={filters.search}
                onChange={(event) => update({ search: event.target.value })}
              />
            </Field>
            <Field label="Status" htmlFor="sales-status">
              <Select
                id="sales-status"
                value={filters.status}
                onChange={(event) => update({ status: event.target.value as SaleStatus | '' })}
              >
                <option value="">All statuses</option>
                {SALE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_WORD[status]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From" htmlFor="sales-from">
              <Input
                id="sales-from"
                type="date"
                value={filters.from}
                onChange={(event) => update({ from: event.target.value })}
              />
            </Field>
            <Field label="To" htmlFor="sales-to" error={dateError ?? undefined}>
              <Input
                id="sales-to"
                type="date"
                value={filters.to}
                onChange={(event) => update({ to: event.target.value })}
              />
            </Field>
          </div>
          {filtersActive && (
            <div className="mt-3">
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          )}
        </Card>

        {loadError !== null && (
          <div className="space-y-3">
            <ErrorNotice>{loadError}</ErrorNotice>
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {loading && loadError === null && (
          <div className="flex justify-center p-12">
            <Spinner label="Loading sales…" />
          </div>
        )}

        {!loading && loadError === null && sales.length === 0 && (
          <Card padded={false}>
            <EmptyState
              title="No sales found"
              message={
                filtersActive
                  ? 'No sale matches these filters.'
                  : 'Sales appear here once the till records them.'
              }
            />
          </Card>
        )}

        {!loading && loadError === null && sales.length > 0 && (
          <div className="space-y-3">
            <ul className="space-y-2">
              {sales.map((sale) => (
                <li key={sale.id}>
                  <Link href={`/sales/${sale.id}`} className="block">
                    <Card className="transition hover:bg-surface-50">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-neutral-900">Sale {sale.saleNumber}</p>
                            <SaleStatusBadge status={sale.status} />
                          </div>
                          <p className="mt-0.5 text-sm text-neutral-500">
                            {formatDateTime(sale.createdAt)}
                            {' · '}
                            {sale.itemCount} {sale.itemCount === 1 ? 'item' : 'items'}
                            {' · served by '}
                            {sale.servedByName}
                          </p>
                          {sale.patientName !== null && (
                            <p className="text-sm text-neutral-600">Patient: {sale.patientName}</p>
                          )}
                          <p className="text-2xs text-neutral-400">
                            {sale.paymentMethods.length === 0
                              ? 'No payment recorded'
                              : sale.paymentMethods.map((method) => METHOD_WORD[method]).join(', ')}
                          </p>
                        </div>
                        <Money
                          value={sale.total}
                          className="shrink-0 text-base font-semibold text-neutral-900"
                        />
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                Previous
              </Button>
              <span className="text-2xs text-neutral-500">
                {offset + 1}–{offset + sales.length}
              </span>
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => current + PAGE_SIZE)}
                disabled={!hasMore || loading}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
