'use client';

/**
 * The read-only pieces every page repeats: a card, a page header, a spinner,
 * status badges, money, notices and the empty state.
 *
 * These exist so a page is assembled from parts that already agree, rather than
 * re-deriving a border radius and a text colour each time. The notices are the
 * ones worth a word: `ErrorNotice` carries `role="alert"` and `StatusNotice`
 * `role="status"`, which is not decoration — an alert interrupts a screen reader
 * to say the sale failed, a status waits for a pause so a "saved" confirmation
 * does not talk over the cashier. Picking the wrong one is the difference
 * between an error being announced and being silently painted red for somebody
 * who cannot see the colour.
 *
 * `Money` runs the API's decimal string through `formatCedis`, so the two
 * representations never meet on a page: the string comes in here and `GHS`-prefixed
 * tabular figures come out, in the `.money` style that keeps a column of prices
 * aligned down the page.
 */

import type { ReactNode } from 'react';

import { formatCedis } from '@/lib/format';

export function Spinner({
  label = 'Loading…',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={[
        'inline-block h-8 w-8 animate-spin rounded-full border-4 border-surface-300 border-t-primary-500',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={[
        'rounded-lg border border-surface-200 bg-white',
        padded ? 'p-4 sm:p-5' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-surface-200 bg-white px-4 py-3 sm:px-6">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-neutral-900">{title}</h1>
        {subtitle !== undefined && <p className="mt-0.5 text-sm text-neutral-600">{subtitle}</p>}
      </div>
      {actions !== undefined && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'positive' | 'negative' | 'warning';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-surface-200 bg-surface-100 text-neutral-700',
  positive: 'border-primary-200 bg-primary-50 text-primary-700',
  negative: 'border-danger-100 bg-danger-50 text-danger-700',
  warning: 'border-accent-300 bg-accent-50 text-accent-900',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium',
        BADGE_TONES[tone],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}

/** An API money string rendered as `GHS 1,234.50` in tabular figures. */
export function Money({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <span className={['money', className ?? ''].filter(Boolean).join(' ')}>
      {formatCedis(value)}
    </span>
  );
}

export function ErrorNotice({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={[
        'rounded border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}

export function WarningNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded border border-accent-300 bg-accent-50 p-3 text-sm text-accent-900"
    >
      {children}
    </div>
  );
}

export function StatusNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded border border-surface-200 bg-surface-50 p-3 text-sm text-neutral-700"
    >
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: ReactNode;
  message?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-semibold text-neutral-800">{title}</p>
      {message !== undefined && <p className="max-w-sm text-sm text-neutral-600">{message}</p>}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
