'use client';

/**
 * The reminder list, and the one action that writes: "Refresh reminders".
 *
 * Reused on `/notifications` (every reminder) and on `/patients/[id]` (one
 * patient's), which is why the patient is a prop rather than a filter the caller
 * has to remember to set. Each row is a `ReminderEntry`, so the honest status and
 * the verbatim `notSentReason` are the same everywhere a reminder is shown.
 *
 * ## The refresh reports what actually happened
 *
 * `POST /notifications/refresh` runs one pass of the scheduler and returns the
 * counts. With no SMS provider configured `sent` is zero and every due reminder
 * lands in `notSent`, so the panel says "0 sent · 12 not sent" and points at the
 * rows that say why — it never reports the pass as work done. `moreDue` says a full
 * batch came back, so "Refresh again" is a choice made on information rather than
 * a guess. The button is gated by `notifications:refresh`, which counter staff do
 * not hold, because running the scheduler writes `not sent` — a clinical statement
 * that a patient was not told.
 */

import { useCallback, useEffect, useState } from 'react';

import { ReminderEntry } from '@/components/notifications/notification-rows';
import { NOTIFICATION_STATUS_WORD } from '@/components/notifications/notifications-words';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorNotice, Spinner, StatusNotice } from '@/components/ui/display';
import { Field, Select } from '@/components/ui/field';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  NotificationStatus,
  RefreshResponse,
  ReminderListResponse,
  ReminderRow,
} from '@/lib/api-types';
import { NOTIFICATION_STATUSES } from '@/lib/api-types';
import {
  refreshDeliveredAny,
  refreshUndelivered,
  reminderQueryFrom,
} from '@/lib/notifications';

const PAGE_SIZE = 50;

const ORDER_OPTIONS = [
  { value: 'upcoming', label: 'Upcoming first' },
  { value: 'recent', label: 'Most recent first' },
] as const;

function countNoun(n: number): string {
  return n === 1 ? 'reminder' : 'reminders';
}

export interface ReminderPanelProps {
  /** When given, the panel shows one patient's reminders rather than every one. */
  patientId?: string;
}

export function ReminderPanel({ patientId }: ReminderPanelProps) {
  const { api, can } = useAuth();
  const canRefresh = can('notifications:refresh');

  const [status, setStatus] = useState('');
  const [order, setOrder] = useState<string>('upcoming');
  const [offset, setOffset] = useState(0);

  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<RefreshResponse | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.get<ReminderListResponse>('/notifications/reminders', {
          query: reminderQueryFrom(
            { patientId: patientId ?? '', kind: '', status, from: '', to: '', order },
            PAGE_SIZE,
            offset
          ),
        });
        if (cancelled) return;
        setReminders(result.reminders);
        setHasMore(result.reminders.length === PAGE_SIZE);
      } catch (caught) {
        if (!cancelled) setLoadError(apiErrorMessage(caught, 'Could not load reminders.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, patientId, status, order, offset, reloadToken]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const result = await api.post<RefreshResponse>('/notifications/refresh');
      setRefreshResult(result);
      reload();
    } catch (caught) {
      setRefreshError(apiErrorMessage(caught, 'Could not refresh reminders.'));
    } finally {
      setRefreshing(false);
    }
  }

  const summary = refreshResult?.summary ?? null;
  const undelivered = summary === null ? 0 : refreshUndelivered(summary);

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-surface-200 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Status" htmlFor="reminder-status" className="min-w-[9rem]">
            <Select
              id="reminder-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">All</option>
              {NOTIFICATION_STATUSES.map((value: NotificationStatus) => (
                <option key={value} value={value}>
                  {NOTIFICATION_STATUS_WORD[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Order" htmlFor="reminder-order" className="min-w-[11rem]">
            <Select
              id="reminder-order"
              value={order}
              onChange={(event) => {
                setOrder(event.target.value);
                setOffset(0);
              }}
            >
              {ORDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {canRefresh && (
          <Button variant="secondary" onClick={() => void refresh()} loading={refreshing}>
            Refresh reminders
          </Button>
        )}
      </div>

      <div className="space-y-3 p-4">
        {refreshError !== null && <ErrorNotice>{refreshError}</ErrorNotice>}

        {summary !== null && (
          <StatusNotice>
            <p>
              {summary.due} {countNoun(summary.due)} due · {summary.sent} sent · {undelivered} not
              sent
              {summary.alreadyDealt > 0 ? ` · ${summary.alreadyDealt} already dealt with` : ''}
            </p>
            {!refreshDeliveredAny(summary) && undelivered > 0 && (
              <p className="mt-1">Nothing was delivered. Each reminder below says why.</p>
            )}
            {refreshResult?.moreDue === true && (
              <p className="mt-1">
                More are still due — refresh again, or the scheduler will pick them up.
              </p>
            )}
          </StatusNotice>
        )}

        {loadError !== null && (
          <div className="space-y-3">
            <ErrorNotice>{loadError}</ErrorNotice>
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {loading && loadError === null && (
          <div className="flex justify-center p-8">
            <Spinner label="Loading reminders…" />
          </div>
        )}

        {!loading && loadError === null && reminders.length === 0 && (
          <EmptyState title="No reminders" message="Nothing is scheduled to go out." />
        )}

        {!loading && loadError === null && reminders.length > 0 && (
          <>
            <ul className="-mx-1 divide-y divide-surface-100">
              {reminders.map((reminder) => (
                <ReminderEntry key={reminder.id} reminder={reminder} />
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 pt-1">
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                Previous
              </Button>
              <span className="text-2xs text-neutral-500">
                {offset + 1}–{offset + reminders.length}
              </span>
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => current + PAGE_SIZE)}
                disabled={!hasMore || loading}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
