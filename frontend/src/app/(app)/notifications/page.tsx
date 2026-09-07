'use client';

/**
 * The bell's whole list, and the reminders behind it. `/notifications`, gated by
 * `notifications:read`.
 *
 * Two things on one page, because they are the two halves of "what has this
 * pharmacy been told". Above is the bell the shell shows eight of: every
 * notification this member of staff can see, filterable by type and by unread, with
 * a way to mark one read or all of them. Below is the `ReminderPanel` — the same
 * component the patient's own page uses, so the honest status and the verbatim
 * `notSentReason` are identical whether one reminder is looked at on a record or
 * every reminder is looked at here.
 *
 * ## Marking read is a whole-pharmacy act, and the page does not pretend otherwise
 *
 * `read_at` is a column on the row and not a per-user join, so whoever reads an
 * alert first reads it for everybody — the decision `notification-rows.tsx`
 * records. Both mark-read routes are `notifications:read`, the permission the page
 * is already gated by, so there is no second gate here and no write button to hide.
 * After either one the list reloads rather than being patched in place: under
 * "unread only" a row that was just read has to leave the list, and only a refetch
 * knows that.
 */

import { useCallback, useEffect, useState } from 'react';

import { NotificationEntry } from '@/components/notifications/notification-rows';
import { ReminderPanel } from '@/components/notifications/reminder-panel';
import { NOTIFICATION_TYPE_WORD } from '@/components/notifications/notifications-words';
import { Button } from '@/components/ui/button';
import {
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  StatusNotice,
} from '@/components/ui/display';
import { Field, Select } from '@/components/ui/field';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  NotificationListResponse,
  NotificationRow,
  NotificationType,
  ReadAllResponse,
} from '@/lib/api-types';
import { NOTIFICATION_TYPES } from '@/lib/api-types';
import {
  bellFiltersActive,
  bellQueryFrom,
  EMPTY_BELL_FILTERS,
  type BellFilters,
} from '@/lib/notifications';

/** The backend's own `DEFAULT_LIST_LIMIT`, so a page is one server page. */
const PAGE_SIZE = 50;

export default function NotificationsPage() {
  const { api } = useAuth();

  const [filters, setFilters] = useState<BellFilters>(EMPTY_BELL_FILTERS);
  const [offset, setOffset] = useState(0);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const filtersActive = bellFiltersActive(filters);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.get<NotificationListResponse>('/notifications', {
          query: bellQueryFrom(filters, PAGE_SIZE, offset),
        });
        if (cancelled) return;
        setNotifications(result.notifications);
        setUnread(result.unread);
        setHasMore(result.notifications.length === PAGE_SIZE);
      } catch (error) {
        if (!cancelled) setLoadError(apiErrorMessage(error, 'Could not load notifications.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, filters, offset, reloadToken]);

  function update(patch: Partial<BellFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  }

  function clearFilters() {
    setFilters(EMPTY_BELL_FILTERS);
    setOffset(0);
  }

  async function markRead(id: string) {
    if (markingId !== null || markingAll) return;
    setMarkingId(id);
    setActionError(null);
    try {
      await api.post<{ notification: NotificationRow }>(`/notifications/${id}/read`);
      reload();
    } catch (error) {
      setActionError(apiErrorMessage(error, 'Could not mark that notification read.'));
    } finally {
      setMarkingId(null);
    }
  }

  async function markAllRead() {
    if (markingAll || markingId !== null) return;
    setMarkingAll(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api.post<ReadAllResponse>('/notifications/read-all');
      setNotice(
        result.read === 0
          ? 'Nothing was unread.'
          : result.read === 1
            ? 'Marked 1 notification as read.'
            : `Marked ${result.read} notifications as read.`
      );
      reload();
    } catch (error) {
      setActionError(apiErrorMessage(error, 'Could not mark notifications read.'));
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle={unread === 0 ? 'Nothing is waiting to be read.' : `${unread} unread.`}
        actions={
          <Button
            variant="secondary"
            onClick={() => void markAllRead()}
            disabled={unread === 0 || markingAll || markingId !== null}
            loading={markingAll}
          >
            Mark all read
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
        {notice !== null && <StatusNotice>{notice}</StatusNotice>}
        {actionError !== null && <ErrorNotice>{actionError}</ErrorNotice>}

        <Card>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Type" htmlFor="notifications-type" className="min-w-[13rem]">
                <Select
                  id="notifications-type"
                  value={filters.type}
                  onChange={(event) => update({ type: event.target.value })}
                >
                  <option value="">All types</option>
                  {NOTIFICATION_TYPES.map((value: NotificationType) => (
                    <option key={value} value={value}>
                      {NOTIFICATION_TYPE_WORD[value]}
                    </option>
                  ))}
                </Select>
              </Field>
              <label
                htmlFor="notifications-unread"
                className="flex min-h-touch-lg items-center gap-2 text-sm"
              >
                <input
                  id="notifications-unread"
                  type="checkbox"
                  className="h-4 w-4 accent-primary-500"
                  checked={filters.unreadOnly}
                  onChange={(event) => update({ unreadOnly: event.target.checked })}
                />
                <span className="text-neutral-700">Unread only</span>
              </label>
            </div>
            {filtersActive && (
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
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
            <Spinner label="Loading notifications…" />
          </div>
        )}

        {!loading && loadError === null && notifications.length === 0 && (
          <Card padded={false}>
            <EmptyState
              title="No notifications"
              message={
                filtersActive
                  ? 'Nothing matches these filters.'
                  : 'Alerts and reminders appear here as they are raised.'
              }
            />
          </Card>
        )}

        {!loading && loadError === null && notifications.length > 0 && (
          <div className="space-y-3">
            <Card padded={false}>
              <ul>
                {notifications.map((notification) => (
                  <NotificationEntry
                    key={notification.id}
                    notification={notification}
                    action={
                      notification.readAt === null ? (
                        <Button
                          variant="ghost"
                          onClick={() => void markRead(notification.id)}
                          loading={markingId === notification.id}
                          disabled={markingId !== null || markingAll}
                        >
                          Mark read
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
            </Card>

            <div className="flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                Previous
              </Button>
              <span className="text-2xs text-neutral-500">
                {offset + 1}–{offset + notifications.length}
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

        <div className="space-y-2 pt-2">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Reminders</h2>
            <p className="mt-0.5 text-2xs text-neutral-500">
              What is scheduled to go out for every patient, and whether it went. A reminder that
              did not reach a patient says so, and says why.
            </p>
          </div>
          <ReminderPanel />
        </div>
      </div>
    </div>
  );
}
