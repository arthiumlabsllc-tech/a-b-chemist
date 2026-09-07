/**
 * The pure logic behind the bell and the reminder panel — and the honesty rule
 * that is the whole point of Phase 8's notifications: a reminder that was never
 * sent says "not sent" and gives the reason the server stored, verbatim, rather
 * than being dressed as a spinner or a quiet nothing.
 *
 * ## Why "not sent" is read and never invented
 *
 * `not_sent` is not a failure and not a pending: it means nothing was attempted,
 * and the row carries a `notSentReason` beside it. With no SMS provider configured
 * — the state this pharmacy is in until A&B sets `SMS_API_URL` and `SMS_API_KEY` —
 * *every* reminder is `not_sent`. A bell that rendered that as "on its way" would
 * be claiming a patient was told something they were not, which is the exact
 * dishonesty `BRIEF.md` §4.4 forbids. So this module classifies a status into
 * whether the patient was actually told and whether an explanation is owed, and it
 * surfaces the stored reason word for word. It never writes a reason of its own.
 *
 * ## Why the filters are single-valued
 *
 * `kind`, `status` and `type` are repeated enum filters on the backend, but
 * `api-client`'s `buildQuery` renders one value per key and `enumListFilter` there
 * does not split a comma-joined string — so `kind=refill,appointment` would arrive
 * as one unknown member and be refused. Every filter here is therefore one value,
 * matching `lib/screenings.ts` and `lib/consultations.ts`.
 */

import type {
  NotificationRow,
  NotificationStatus,
  RefreshSummary,
  ReminderRow,
} from './api-types';

// ---------------------------------------------------------------------------
// The bell: GET /notifications
// ---------------------------------------------------------------------------

/**
 * The bell's filters. `type` is one of the five notification types or empty for
 * all; `unreadOnly` is the toggle that hides everything already read.
 */
export interface BellFilters {
  type: string;
  unreadOnly: boolean;
}

export const EMPTY_BELL_FILTERS: BellFilters = { type: '', unreadOnly: false };

/**
 * The query for `GET /notifications`, sending only what is set.
 *
 * `unreadOnly` is sent as `'true'` when on and omitted when off, not sent as
 * `'false'`: the route reads an absent key as "nobody asked about the read ones"
 * and a present `false` as a positive request for them, and the two are kept apart
 * on purpose in `booleanFilter`. Sending only the on-state preserves that.
 */
export function bellQueryFrom(
  filters: BellFilters,
  limit: number,
  offset: number
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit, offset };
  const type = filters.type.trim();
  if (type !== '') query.type = type;
  if (filters.unreadOnly) query.unreadOnly = 'true';
  return query;
}

/** Whether the bell is filtered, so the page offers "Clear". */
export function bellFiltersActive(filters: BellFilters): boolean {
  return filters.type.trim() !== '' || filters.unreadOnly;
}

// ---------------------------------------------------------------------------
// The reminder panel: GET /notifications/reminders
// ---------------------------------------------------------------------------

/**
 * The reminder panel's filters. Each is one value; `order` is a view toggle
 * (`upcoming` or `recent`) rather than a filter, so `reminderFiltersActive`
 * ignores it exactly as the diary ignores its own order toggle.
 */
export interface ReminderFilters {
  patientId: string;
  kind: string;
  status: string;
  from: string;
  to: string;
  order: string;
}

export const EMPTY_REMINDER_FILTERS: ReminderFilters = {
  patientId: '',
  kind: '',
  status: '',
  from: '',
  to: '',
  order: '',
};

/** The query for `GET /notifications/reminders`, sending only the filters set. */
export function reminderQueryFrom(
  filters: ReminderFilters,
  limit: number,
  offset: number
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit, offset };
  const patientId = filters.patientId.trim();
  if (patientId !== '') query.patientId = patientId;
  const kind = filters.kind.trim();
  if (kind !== '') query.kind = kind;
  const status = filters.status.trim();
  if (status !== '') query.status = status;
  const from = filters.from.trim();
  if (from !== '') query.from = from;
  const to = filters.to.trim();
  if (to !== '') query.to = to;
  const order = filters.order.trim();
  if (order !== '') query.order = order;
  return query;
}

/** Whether a filter — not the order toggle — is set, so the page offers "Clear". */
export function reminderFiltersActive(filters: ReminderFilters): boolean {
  return (
    filters.patientId.trim() !== '' ||
    filters.kind.trim() !== '' ||
    filters.status.trim() !== '' ||
    filters.from.trim() !== '' ||
    filters.to.trim() !== ''
  );
}

// ---------------------------------------------------------------------------
// The honest classification of a status
// ---------------------------------------------------------------------------

/**
 * Whether each status means the patient was actually told. Only `sent` does.
 *
 * A `Record` over the union rather than a chain of `if`s so a fifth status added
 * to `NOTIFICATION_STATUSES` is a compile error here until somebody decides
 * whether it counts as delivery. That decision is too load-bearing to leave to a
 * fall-through default: getting it wrong is a bell that lies.
 */
const DELIVERED: Record<NotificationStatus, boolean> = {
  pending: false,
  sent: true,
  not_sent: false,
  failed: false,
};

/**
 * Whether each status owes the reader an explanation. `not_sent` and `failed` do,
 * and the schema guarantees a `notSentReason` beside them with a check constraint
 * — so this app never has to defend against an unexplained one, and never invents
 * a reason for one.
 */
const OWES_REASON: Record<NotificationStatus, boolean> = {
  pending: false,
  sent: false,
  not_sent: true,
  failed: true,
};

/**
 * The honest words for the case that cannot happen: a `not_sent` or `failed` row
 * with no reason beside it. The check constraint makes this unreachable, so it is a
 * last line of defence rather than an expected value — and it says "nothing was
 * recorded" instead of guessing a cause. Inventing "no SMS provider" for a row that
 * failed for a different reason would be the same lie pointed the other way.
 */
export const UNEXPLAINED_UNSENT = 'No reason was recorded.';

/**
 * What a row honestly means at the counter, derived only from its `status` and the
 * reason the schema guarantees beside a `not_sent` or `failed` one.
 */
export interface DeliveryState {
  /** True only when the patient was actually told — that is, only for `sent`. */
  delivered: boolean;
  /** True when the row owes an explanation, so the UI must show one. */
  owesReason: boolean;
  /** The verbatim stored reason for a row that owes one, or null otherwise. */
  reason: string | null;
}

/**
 * Classifies one status. The reason is returned exactly as stored — never
 * rewritten, never paraphrased — because it is the server's statement of why the
 * patient was not told, and the UI's only job is to show it.
 */
export function deliveryStateOf(
  status: NotificationStatus,
  notSentReason: string | null
): DeliveryState {
  const owesReason = OWES_REASON[status];
  let reason: string | null = null;
  if (owesReason) {
    const trimmed = notSentReason === null ? '' : notSentReason.trim();
    reason = trimmed === '' ? UNEXPLAINED_UNSENT : notSentReason;
  }
  return { delivered: DELIVERED[status], owesReason, reason };
}

/** The honest state of one reminder row. */
export function reminderStateOf(row: ReminderRow): DeliveryState {
  return deliveryStateOf(row.status, row.notSentReason);
}

/** The honest state of one bell row. */
export function notificationStateOf(row: NotificationRow): DeliveryState {
  return deliveryStateOf(row.status, row.notSentReason);
}

// ---------------------------------------------------------------------------
// Reading a refresh pass honestly
// ---------------------------------------------------------------------------

/**
 * Whether a refresh pass actually delivered anything.
 *
 * The toast a "Refresh reminders" button raises must not say the work was done
 * unless it was, and with no provider configured `sent` stays zero on every pass.
 * A UI that reported "12 reminders processed" would be claiming deliveries that
 * never happened; this is the single fact that keeps it honest.
 */
export function refreshDeliveredAny(summary: RefreshSummary): boolean {
  return summary.sent > 0;
}

/**
 * How many reminders a pass left undelivered — the count that must be surfaced
 * rather than hidden behind `due`.
 *
 * `notSent` and `failed` are kept apart from each other on the row because they
 * mean different things, but they are added here because the headline a pharmacist
 * needs is "how many patients were not told", and both states answer it. `alreadyDealt`
 * is excluded: those were handled by an earlier pass, not left undelivered by this
 * one.
 */
export function refreshUndelivered(summary: RefreshSummary): number {
  return summary.notSent + summary.failed;
}
