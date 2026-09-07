/**
 * The words and badge tones the bell and the reminder panel render, in one place.
 *
 * ## The status words are the honesty rule made visible
 *
 * `pending` reads "Not attempted yet" and `not_sent` reads "Not sent" — neither is
 * allowed to read "Sent" or "Delivered", because with no SMS provider configured
 * every reminder is `not_sent` and a label that implied otherwise would be telling
 * a pharmacist a patient was contacted when they were not (`BRIEF.md` §4.4). The
 * tone agrees: `not_sent` is a warning that needs a person, `failed` a negative,
 * and only `sent` is positive. `lib/notifications.ts` decides *whether* a row was
 * delivered and *what reason* it owes; this file only supplies the word and the
 * colour for the status it is given.
 */

import type { BadgeTone } from '@/components/ui/display';
import type { NotificationStatus, NotificationType, ReminderKind } from '@/lib/api-types';

export const NOTIFICATION_TYPE_WORD: Record<NotificationType, string> = {
  refill_reminder: 'Refill reminder',
  appointment_reminder: 'Appointment reminder',
  stock_expiry: 'Stock expiry',
  stock_reorder: 'Reorder point',
  product_recall: 'Product recall',
};

export const NOTIFICATION_STATUS_WORD: Record<NotificationStatus, string> = {
  pending: 'Not attempted yet',
  sent: 'Sent',
  not_sent: 'Not sent',
  failed: 'Failed to send',
};

export const NOTIFICATION_STATUS_TONE: Record<NotificationStatus, BadgeTone> = {
  pending: 'neutral',
  sent: 'positive',
  not_sent: 'warning',
  failed: 'negative',
};

export const REMINDER_KIND_WORD: Record<ReminderKind, string> = {
  refill: 'Refill',
  appointment: 'Appointment',
};
