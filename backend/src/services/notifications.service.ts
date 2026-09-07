import { poolSql } from '../database/pool';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  type NotificationFilters,
  type NotificationRow,
} from '../repositories/notifications.repository';
import { nowIso } from '../utils/clock';
import { notFound } from '../utils/http';
import {
  DEFAULT_REMINDER_BATCH_LIMIT,
  refreshReminders,
  type RefreshSummary,
} from './reminders.service';

/**
 * The bell: what has been raised, what nobody has read yet, and one way to make
 * the scheduler run now instead of on the quarter hour.
 *
 * ## Everything here reads persisted rows
 *
 * There is no derivation anywhere in this module, and that is the point of it. A
 * reminder re-computed at request time would show a refill as due the moment the
 * rule said so — including after it had been sent, superseded or dealt with — and
 * the bell would then disagree with its own history and with the row the scheduler
 * acted on. `listNotifications` reads `notifications`; the dashboard's reminder list
 * reads `reminders` through `reminders.service.listReminderPage`. Both are records
 * of what happened rather than opinions about what should.
 *
 * ## The badge travels with the list
 *
 * `unread` is returned beside the page rather than from its own endpoint. Two calls
 * would be two chances for the number above the bell and the rows under it to come
 * from different moments, and a badge that says 3 over a list of four unread rows is
 * the kind of small disagreement that makes somebody stop trusting both. `countUnread`
 * counts rather than reading the length of a page because the page is limited, so a
 * caller paging through twenty would otherwise watch their badge fall as they scrolled.
 *
 * ## Reading is shared, and the UI has to say so
 *
 * `read_at` is on the row, not in a per-user join table, so a broadcast has one read
 * state for the whole pharmacy: when anybody marks it read it is read for everyone.
 * `notifications.repository.ts` records why that is the more useful fact for a small
 * team and this module does not soften it. What it means for the frontend is that
 * "mark all read" is a statement about the pharmacy and not about the person clicking
 * it, which is why the row's `userId` is returned unmodified — null is how the UI
 * tells a broadcast from a message aimed at one member of staff.
 */

/**
 * One bell entry, as the API returns it.
 *
 * The row and nothing added. There is no `shared` or `isBroadcast` field beside
 * `userId` because the two would be one fact in two spellings, and a frontend that
 * read the derived one would keep working the day the derivation was removed while
 * the meaning quietly changed. Exported because it is the contract:
 * `frontend/src/lib/api-types.ts` copies it and `api-types.mirror.test.ts` reads this
 * declaration to hold the two together.
 */
export type NotificationView = NotificationRow;

export interface NotificationPage {
  notifications: NotificationView[];
  /**
   * Everything this member of staff can see that nobody has read, counted over the
   * whole table rather than over the page. See the header.
   */
  unread: number;
  limit: number;
  offset: number;
}

/** What "mark all read" reports back. */
export interface ReadAllResult {
  /**
   * How many rows this call read. Zero on a second click, because `markAllRead` is
   * scoped to `read_at is null` — so the answer is "how many I just read" and not
   * "how many matched", and a bell cleared twice does not report the same number twice.
   */
  read: number;
}

export interface RefreshResult {
  summary: RefreshSummary;
  /**
   * True when the batch came back full, so there may be more still pending.
   *
   * One pass rather than a drain, because this is an HTTP request and a request has
   * to return: `scripts/run-reminders.ts` loops until nothing is due, and it can
   * afford to because nothing is waiting on it. Saying so is what stops a full batch
   * reading as a finished one — the caller can press the button again, and the
   * quarter-hourly cron will pick the remainder up whatever anybody does.
   */
  moreDue: boolean;
}

/**
 * The bell. `notifications:read`.
 *
 * Both reads outside a transaction, for the reason `listPatientPage` records: the
 * cost of making the pair exact is a lock held across two queries to serve a badge,
 * and what it buys is a count one notification out for the milliseconds between
 * them — which is also what the bell would show a moment later on refresh.
 */
export async function listNotificationPage(
  pharmacyId: string,
  userId: string,
  filters: NotificationFilters
): Promise<NotificationPage> {
  const [notifications, unread] = await Promise.all([
    listNotifications(poolSql, pharmacyId, filters),
    countUnread(poolSql, pharmacyId, userId),
  ]);
  return {
    notifications,
    unread,
    limit: filters.limit,
    offset: filters.offset,
  };
}

/**
 * Marks one entry read. `notifications:read`.
 *
 * A null from `markRead` is either a row that does not exist or one aimed at a
 * different member of staff, and both answer 404 with the same words — telling them
 * apart would be a way to enumerate which notifications exist for other people, for
 * the reason `utils/http.ts` records.
 *
 * `at` comes from `nowIso()` rather than from Postgres's `now()` so the stamp agrees
 * with everything else written in the same request, which is what makes a timeline
 * built from several tables sortable.
 */
export async function readNotification(
  pharmacyId: string,
  userId: string,
  notificationId: string
): Promise<NotificationView> {
  const row = await markRead(poolSql, pharmacyId, userId, notificationId, nowIso());
  if (row === null) throw notFound('notification');
  return row;
}

/**
 * Marks everything this member of staff can see as read. `notifications:read`.
 *
 * On a broadcast that reads it for the whole pharmacy, and the sentence is not a
 * caveat bolted on afterwards: `markAllRead` matches the same visibility rule
 * `listNotifications` does, so the set it clears is exactly the set the bell was
 * showing. Nothing is cleared that the caller could not already see.
 */
export async function readAllNotifications(
  pharmacyId: string,
  userId: string
): Promise<ReadAllResult> {
  return { read: await markAllRead(poolSql, pharmacyId, userId, nowIso()) };
}

/**
 * Deals with every reminder that is pending and due, once. `notifications:refresh`.
 *
 * The manual form of the scheduler hook, and it exists because the quarter hour is
 * too long to wait in one specific situation: an appointment booked for later today
 * gets a reminder due immediately, since `due_at` cannot precede the row that holds
 * it, and the patient should be told now rather than at the next tick.
 *
 * The summary is returned whole rather than collapsed into a count. `sent`,
 * `notSent`, `failed` and `alreadyDealt` are four different facts and Phase 8's
 * honesty line is about the second one: while no provider is configured every
 * reminder is dealt with as `not sent`, so a response reading "processed 12
 * reminders" would be a sentence an operator would believe and a patient would not.
 */
export async function refreshDueReminders(pharmacyId: string): Promise<RefreshResult> {
  const summary = await refreshReminders(pharmacyId, nowIso());
  return {
    summary,
    moreDue: summary.due >= DEFAULT_REMINDER_BATCH_LIMIT,
  };
}
