'use client';

/**
 * The dashboard — the page signing in lands on.
 *
 * ## What it is, and what it deliberately is not
 *
 * A morning view, not a second copy of the reports: three readings of what is
 * already on the server — how today is going, what is waiting to be read, and the
 * last few sales — each linking through to the page that owns it in full. Nothing
 * here is writable and nothing here is authoritative: every figure is the same
 * figure the destination page shows, fetched from the same endpoint, so the
 * dashboard can never disagree with the page it is summarising.
 *
 * ## Every card wears the gate of the page it links to
 *
 * The takings card is `reports:read`, the same permission as `/reports`; the
 * attention card is `notifications:read`, the same as `/notifications`; the recent
 * sales card is `sales:read`, the same as `/sales`. Gating a card on anything
 * looser would show a cashier a number the API would then refuse to hand over. The
 * page itself is gated `sales:read` — the one permission all three roles hold, so
 * the landing redirect reaches it for everybody while the nav table keeps its rule
 * that every destination names a permission. A role with none of the three cards
 * still gets the quick actions, which are gated the same way, so nobody signs into
 * a blank shell.
 *
 * ## Three fetches that fail separately
 *
 * Each card holds its own loading / error / ready state. A reports endpoint that
 * is slow or refused must not blank the notifications beside it: on a till over a
 * dodgy connection half a dashboard that is true beats none of one that is not.
 *
 * ## "Today" is read once
 *
 * `todayIso` at mount, the same rule `/reports` follows, so a dashboard left open
 * past midnight does not relabel yesterday's figures as today's while nobody was
 * looking. The window is sent as both ends, so the server cannot fill one from a
 * clock that moved between the click and the request.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { SaleStatusBadge } from '@/components/pos/receipt';
import { Button } from '@/components/ui/button';
import { ErrorNotice, Money, PageHeader, Spinner } from '@/components/ui/display';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  NotificationListResponse,
  SalesListResponse,
  SalesReport,
  SalesReportResponse,
} from '@/lib/api-types';
import { todayIso } from '@/lib/dates';
import { formatDate, formatDateTime, MISSING } from '@/lib/format';
import { bellQueryFrom, EMPTY_BELL_FILTERS } from '@/lib/notifications';
import { salesQueryFrom, EMPTY_SALES_FILTERS } from '@/lib/sales';

/** Enough rows to see the shape of the day without scrolling past the fold. */
const CARD_LIMIT = 5;

/** One card's round trip: not started is not a state, because every card starts. */
type Load<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; value: T };

export default function DashboardPage() {
  const { api, can } = useAuth();
  const router = useRouter();

  const [today] = useState(todayIso);
  const [reloadToken, setReloadToken] = useState(0);

  const canReports = can('reports:read');
  const canNotifications = can('notifications:read');
  const canSales = can('sales:read');

  const [report, setReport] = useState<Load<SalesReport> | null>(null);
  const [bell, setBell] = useState<Load<NotificationListResponse> | null>(null);
  const [recent, setRecent] = useState<Load<SalesListResponse> | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (canReports) {
      setReport({ kind: 'loading' });
      api
        .get<SalesReportResponse>('/reports/sales', {
          query: { from: today, to: today, limit: 1, offset: 0 },
        })
        .then((result) => {
          if (!cancelled) setReport({ kind: 'ready', value: result.report });
        })
        .catch((error) => {
          if (!cancelled) setReport({ kind: 'error', message: apiErrorMessage(error, 'Today’s figures could not be loaded.') });
        });
    }

    if (canNotifications) {
      setBell({ kind: 'loading' });
      api
        .get<NotificationListResponse>('/notifications', {
          query: bellQueryFrom(EMPTY_BELL_FILTERS, CARD_LIMIT, 0),
        })
        .then((result) => {
          if (!cancelled) setBell({ kind: 'ready', value: result });
        })
        .catch((error) => {
          if (!cancelled) setBell({ kind: 'error', message: apiErrorMessage(error, 'The notifications could not be loaded.') });
        });
    }

    if (canSales) {
      setRecent({ kind: 'loading' });
      api
        .get<SalesListResponse>('/sales', {
          query: salesQueryFrom(EMPTY_SALES_FILTERS, CARD_LIMIT, 0),
        })
        .then((result) => {
          if (!cancelled) setRecent({ kind: 'ready', value: result });
        })
        .catch((error) => {
          if (!cancelled) setRecent({ kind: 'error', message: apiErrorMessage(error, 'The recent sales could not be loaded.') });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [api, canReports, canNotifications, canSales, today, reloadToken]);

  const quickLinks = [
    { href: '/pos', label: 'Open the till', show: can('sales:create') },
    { href: '/inventory', label: 'Inventory', show: can('inventory:read') },
    { href: '/patients', label: 'Patients', show: can('patients:read') },
    { href: '/sales', label: 'Sales', show: canSales },
    { href: '/notifications', label: 'Notifications', show: canNotifications },
    { href: '/reports', label: 'Reports', show: canReports },
  ].filter((link) => link.show);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        subtitle={`${formatDate(today)} · the pharmacy at a glance`}
        actions={
          can('sales:create') ? (
            <Button variant="primary" size="md" onClick={() => router.push('/pos')}>
              Open the till
            </Button>
          ) : undefined
        }
      />

      {canReports && (
        <section aria-label="Today so far" className="grid gap-3 sm:grid-cols-3">
          {report === null || report.kind === 'loading' ? (
            <>
              <StatCard label="Takings today">
                <Spinner />
              </StatCard>
              <StatCard label="Sales today">
                <Spinner />
              </StatCard>
              <StatCard label="Average basket">
                <Spinner />
              </StatCard>
            </>
          ) : report.kind === 'error' ? (
            <div className="sm:col-span-3">
              <ErrorNotice>
                {report.message}{' '}
                <Button variant="secondary" size="md" onClick={() => setReloadToken((t) => t + 1)}>
                  Try again
                </Button>
              </ErrorNotice>
            </div>
          ) : (
            <>
              <StatCard label="Takings today">
                <Money value={report.value.summary.revenue} />
              </StatCard>
              <StatCard label="Sales today">
                <span className="money">{report.value.summary.saleCount}</span>
              </StatCard>
              <StatCard label="Average basket">
                {report.value.summary.averageSale === null ? (
                  MISSING
                ) : (
                  <Money value={report.value.summary.averageSale} />
                )}
              </StatCard>
            </>
          )}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {canNotifications && (
          <PanelCard
            title="Needs attention"
            action={
              bell?.kind === 'ready' && bell.value.unread > 0 ? (
                <span className="rounded-full bg-primary-100 px-2 py-0.5 text-2xs font-semibold text-primary-800">
                  {bell.value.unread} unread
                </span>
              ) : undefined
            }
            footer={
              <Link href="/notifications" className="text-2xs font-semibold text-primary-700 hover:underline">
                View all notifications
              </Link>
            }
          >
            {bell === null || bell.kind === 'loading' ? (
              <Spinner />
            ) : bell.kind === 'error' ? (
              <ErrorNotice>{bell.message}</ErrorNotice>
            ) : bell.value.notifications.length === 0 ? (
              <p className="text-sm text-neutral-500">Nothing is waiting to be read.</p>
            ) : (
              <ul className="divide-y divide-surface-100">
                {bell.value.notifications.map((notification) => (
                  <li key={notification.id} className="py-2">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {notification.title}
                    </p>
                    <p className="text-2xs text-neutral-500">
                      {formatDateTime(notification.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </PanelCard>
        )}

        {canSales && (
          <PanelCard
            title="Recent sales"
            footer={
              <Link href="/sales" className="text-2xs font-semibold text-primary-700 hover:underline">
                View all sales
              </Link>
            }
          >
            {recent === null || recent.kind === 'loading' ? (
              <Spinner />
            ) : recent.kind === 'error' ? (
              <ErrorNotice>{recent.message}</ErrorNotice>
            ) : recent.value.sales.length === 0 ? (
              <p className="text-sm text-neutral-500">No sales recorded yet.</p>
            ) : (
              <ul className="divide-y divide-surface-100">
                {recent.value.sales.map((sale) => (
                  <li key={sale.id} className="py-2">
                    <Link
                      href={`/sales/${sale.id}`}
                      className="flex items-center justify-between gap-3 rounded-md hover:bg-surface-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-neutral-900">
                          {sale.saleNumber}
                        </span>
                        <span className="block text-2xs text-neutral-500">
                          {formatDateTime(sale.createdAt)} · {sale.itemCount} item
                          {sale.itemCount === 1 ? '' : 's'}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Money value={sale.total} className="text-sm font-semibold text-neutral-900" />
                        <SaleStatusBadge status={sale.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </PanelCard>
        )}
      </div>

      {quickLinks.length > 0 && (
        <section aria-label="Quick actions" className="flex flex-wrap gap-2">
          {quickLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex min-h-touch items-center rounded-md border border-surface-200 bg-white px-3 text-sm font-medium text-neutral-700 hover:bg-surface-100"
            >
              {link.label}
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}

function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-surface-200 bg-white p-4">
      <p className="text-2xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-neutral-900">{children}</p>
    </div>
  );
}

function PanelCard({
  title,
  action,
  footer,
  children,
}: {
  title: string;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-lg border border-surface-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-surface-200 px-4 py-3">
        <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
        {action}
      </div>
      <div className="flex-1 px-4 py-2">{children}</div>
      {footer !== undefined && (
        <div className="border-t border-surface-100 px-4 py-2">{footer}</div>
      )}
    </section>
  );
}
