'use client';

/**
 * One bell row and one reminder row, rendered honestly.
 *
 * Both are display-only and take an optional `action` node, so the same row serves
 * the bell dropdown, the `/notifications` page and a patient's own reminder list
 * without three copies drifting apart. The honesty lives in what they refuse to
 * say: a `pending` or `not_sent` row never reads "sent", and a row that owes a
 * reason shows the one the server stored, verbatim — `lib/notifications.ts` decides
 * whether one is owed and what it is, and this file only paints it.
 */

import type { ReactNode } from 'react';

import {
  NOTIFICATION_STATUS_TONE,
  NOTIFICATION_STATUS_WORD,
  NOTIFICATION_TYPE_WORD,
  REMINDER_KIND_WORD,
} from '@/components/notifications/notifications-words';
import { Badge } from '@/components/ui/display';
import type { NotificationRow, ReminderRow } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { notificationStateOf, reminderStateOf } from '@/lib/notifications';

/** The reason is painted in the colour of the state it explains. */
function reasonClass(status: NotificationRow['status']): string {
  return status === 'failed' ? 'text-danger-700' : 'text-accent-900';
}

export function NotificationEntry({
  notification,
  action,
}: {
  notification: NotificationRow;
  action?: ReactNode;
}) {
  const state = notificationStateOf(notification);
  const unread = notification.readAt === null;
  return (
    <li className="border-b border-surface-100 px-3 py-2 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {unread && (
            <span
              aria-hidden="true"
              className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary-500"
            />
          )}
          <p
            className={[
              'min-w-0 text-sm',
              unread ? 'font-semibold text-neutral-900' : 'font-medium text-neutral-700',
            ].join(' ')}
          >
            {notification.title}
          </p>
        </div>
        <Badge tone={NOTIFICATION_STATUS_TONE[notification.status]}>
          {NOTIFICATION_STATUS_WORD[notification.status]}
        </Badge>
      </div>
      <p className="mt-0.5 text-2xs text-neutral-500">
        {NOTIFICATION_TYPE_WORD[notification.type]} · {formatDateTime(notification.createdAt)}
      </p>
      {notification.body !== null && (
        <p className="mt-1 text-sm text-neutral-600">{notification.body}</p>
      )}
      {state.owesReason && state.reason !== null && (
        <p className={['mt-1 text-2xs', reasonClass(notification.status)].join(' ')}>
          {state.reason}
        </p>
      )}
      {action !== undefined && <div className="mt-1.5">{action}</div>}
    </li>
  );
}

export function ReminderEntry({ reminder }: { reminder: ReminderRow }) {
  const state = reminderStateOf(reminder);
  return (
    <li className="border-b border-surface-100 px-3 py-2 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{REMINDER_KIND_WORD[reminder.kind]}</Badge>
          <span className="text-2xs text-neutral-500">Due {formatDateTime(reminder.dueAt)}</span>
        </div>
        <Badge tone={NOTIFICATION_STATUS_TONE[reminder.status]}>
          {NOTIFICATION_STATUS_WORD[reminder.status]}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-neutral-700">{reminder.message}</p>
      {state.owesReason && state.reason !== null && (
        <p className={['mt-1 text-2xs', reasonClass(reminder.status)].join(' ')}>{state.reason}</p>
      )}
    </li>
  );
}
