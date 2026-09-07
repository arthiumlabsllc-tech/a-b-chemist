'use client';

/**
 * The bell in the app shell: an unread badge and a dropdown of recent entries.
 *
 * ## What it reads, and when
 *
 * One `GET /notifications` carries both the rows and the whole-table `unread`
 * count, so the badge and the list it counts cannot come from two different
 * moments — a bell showing 3 above two rows is the disagreement that makes
 * somebody stop trusting either number. It loads on mount so the badge is right
 * before the bell is ever opened, again when the dropdown opens, and again after
 * "Mark all read". It does not poll: a request per interval from every signed-in
 * tablet shares one IP rate-limit bucket behind the pharmacy's NAT.
 *
 * ## Hiding is not authorisation
 *
 * The bell renders only for somebody holding `notifications:read`, and even then
 * the API re-checks on every call. A cashier without it sees no bell rather than
 * one that answers 403.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { NotificationEntry } from '@/components/notifications/notification-rows';
import { Button } from '@/components/ui/button';
import { ErrorNotice, Spinner } from '@/components/ui/display';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  NotificationListResponse,
  NotificationRow,
  ReadAllResponse,
} from '@/lib/api-types';
import { bellQueryFrom, EMPTY_BELL_FILTERS } from '@/lib/notifications';

/** A dropdown shows the newest few; the whole list is a page away. */
const BELL_LIMIT = 8;

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export function NotificationBell() {
  const { api, can } = useAuth();
  const canRead = can('notifications:read');

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<NotificationListResponse>('/notifications', {
        query: bellQueryFrom(EMPTY_BELL_FILTERS, BELL_LIMIT, 0),
      });
      setItems(result.notifications);
      setUnread(result.unread);
    } catch (caught) {
      setError(apiErrorMessage(caught, 'Could not load notifications.'));
    } finally {
      setLoading(false);
    }
  }, [api, canRead]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markAllRead() {
    if (markingAll) return;
    setMarkingAll(true);
    setError(null);
    try {
      await api.post<ReadAllResponse>('/notifications/read-all');
      await load();
    } catch (caught) {
      setError(apiErrorMessage(caught, 'Could not mark notifications read.'));
    } finally {
      setMarkingAll(false);
    }
  }

  // Every hook has run, so returning null here cannot skip one.
  if (!canRead) return null;

  const badge = unread > 9 ? '9+' : String(unread);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={() =>
          setOpen((current) => {
            const next = !current;
            if (next) void load();
            return next;
          })
        }
        className="relative inline-flex min-h-touch min-w-touch items-center justify-center rounded-md text-neutral-600 hover:bg-surface-100 hover:text-neutral-900"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-danger-500 px-1 text-2xs font-semibold leading-[18px] text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* A real button rather than a div with an onClick: click-outside-to-close
              needs an interactive element, and the a11y rules reject a handler on a
              plain div. Out of the tab order so it is not a stop of its own. */}
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close notifications"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="dialog"
            aria-label="Notifications"
            className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-lg border border-surface-200 bg-white shadow-xl"
          >
            <div className="flex items-center justify-between gap-2 border-b border-surface-200 px-3 py-2">
              <p className="text-sm font-semibold text-neutral-900">Notifications</p>
              <Button
                variant="ghost"
                onClick={() => void markAllRead()}
                disabled={unread === 0 || markingAll}
                loading={markingAll}
              >
                Mark all read
              </Button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {error !== null && (
                <div className="p-3">
                  <ErrorNotice>{error}</ErrorNotice>
                </div>
              )}
              {loading && items.length === 0 && error === null && (
                <div className="flex justify-center p-6">
                  <Spinner label="Loading notifications…" />
                </div>
              )}
              {!loading && error === null && items.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-neutral-500">
                  Nothing to show yet.
                </p>
              )}
              {items.length > 0 && (
                <ul>
                  {items.map((notification) => (
                    <NotificationEntry key={notification.id} notification={notification} />
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t border-surface-200 bg-surface-50 px-3 py-2">
              <Link
                href="/notifications"
                onClick={() => setOpen(false)}
                className="block text-sm font-medium text-primary-700 hover:text-primary-800"
              >
                View all notifications
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
