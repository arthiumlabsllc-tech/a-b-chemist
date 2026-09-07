import { Router } from 'express';
import { param, query } from 'express-validator';
import { authorize } from '../middleware/authorize';
import { requireAuth } from '../middleware/authenticate';
import {
  listNotificationPage,
  readAllNotifications,
  readNotification,
  refreshDueReminders,
} from '../services/notifications.service';
import { listReminderPage } from '../services/reminders.service';
import { asyncHandler } from '../utils/async-handler';
import { toBoolean, toDateOnlyOrNull, toEnumMember } from '../utils/coerce';
import { sendOk } from '../utils/http';
import {
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  REMINDER_KINDS,
} from '../utils/schema-enums';
import { runValidation } from '../utils/validate';
import { booleanQuery, enumListFilter, idParam, OPTIONAL_QUERY, pageOf, pagination } from './shared';

/**
 * The bell, and the reminder list behind the dashboard panel.
 *
 * Mounted behind `authenticate` alone, with `authorize` naming the permission on
 * each route. Four of the five are `notifications:read`, which counter staff hold;
 * the fifth is `notifications:refresh`, which they do not, because running the
 * scheduler writes a status onto every reminder it picks up and `not sent` is a
 * clinical statement that the patient was not told.
 *
 * ## Everything here reads persisted rows
 *
 * There is no route on this router that derives a notification from stock levels or
 * from appointment times, and that is the acceptance criterion rather than an
 * implementation detail: the bell reads what was written, so what it shows is what
 * the scheduler decided and not what a second piece of logic thinks right now. Two
 * derivations of the same alert is two answers to one question, and the one the
 * bell shows is the one nobody can point at afterwards.
 *
 * ## `visibleTo` is the caller and not a filter
 *
 * `GET /notifications` is always scoped to the signed-in user. It could have been a
 * query parameter, and an owner would then have been able to ask for the whole
 * pharmacy's bell — but `notifications.read_at` is a column on the row and not a
 * join table, so "read" is shared: whoever reads it first reads it for everybody.
 * A per-user scope on the read is the only thing that makes the unread count mean
 * something, and a filter that could widen it would widen the count too.
 *
 * ## Route order
 *
 * `/reminders`, `/read-all` and `/refresh` are declared before `/:id/read`, which
 * is the house rule `inventory.routes.ts` and `sales.routes.ts` both record. It is
 * worth saying plainly that it does not bite here: `/:id/read` is two segments and
 * the three literals are one, so Express cannot match one against the other
 * whatever the order. They are declared first anyway, because the rule is cheaper
 * to follow than to reason about each time, and because a `GET /notifications/:id`
 * added later would make `GET /notifications/reminders` a live collision.
 */
export const notificationsRoutes = Router();

const NOTIFICATION_TYPE_SET: ReadonlySet<string> = new Set(NOTIFICATION_TYPES);
const NOTIFICATION_STATUS_SET: ReadonlySet<string> = new Set(NOTIFICATION_STATUSES);
const REMINDER_KIND_SET: ReadonlySet<string> = new Set(REMINDER_KINDS);

/**
 * The phrase `?unreadOnly` is refused with, in one place.
 *
 * Both the validator and the reader below take it, so the two cannot start
 * wording the same field differently. `routes/shared.ts` records why the phrase is
 * a parameter at all.
 */
const UNREAD_LABEL = 'the unread filter';

/**
 * A repeated enum filter, checked and then narrowed.
 *
 * The `.custom` gives the field-level 400 envelope; `toEnumMember` gives the type,
 * inferred from the `allowed` list rather than written out here — which is why this
 * file imports no enum types at all, and why a value added to `REMINDER_KINDS`
 * widens this function's answer without an edit.
 *
 * Both run, and the duplication is the established shape rather than belt and
 * braces for its own sake: these values go into `::notification_type[]` and
 * `::reminder_kind[]` comparisons, where being wrong is a 500 on every request
 * rather than a message a person can act on.
 */
function enumFilter<T extends string>(raw: unknown, allowed: readonly T[], field: string): T[] {
  return enumListFilter(raw).map((entry) => toEnumMember(entry, allowed, field));
}

/**
 * A `?unreadOnly` that arrives as text, because a URL always carries text.
 *
 * Absent stays absent rather than becoming `false`. The two mean the same thing to
 * the repository, but `unreadOnly: false` in a filter object is a claim that
 * somebody asked for the read ones too, and an absent key is the truth: nobody
 * asked about them at all. `inventory.routes.ts` wants the opposite — a missing
 * `includeInactive` is a settled `false` — so the two handlers read the value
 * their own way and share only the validator.
 */
function booleanFilter(raw: unknown, field: string): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return toBoolean(raw, field);
}

// --- The reminder list, and the two whole-panel actions -----------------------

notificationsRoutes.get(
  '/reminders',
  authorize('notifications:read'),
  ...pagination,
  query('patientId', 'That is not a valid patient id').optional(OPTIONAL_QUERY).isUUID(),
  query('kind', `Kind must be one of ${REMINDER_KINDS.join(', ')}`)
    .optional(OPTIONAL_QUERY)
    .custom((value: unknown) =>
      enumListFilter(value).every(
        (entry) => typeof entry === 'string' && REMINDER_KIND_SET.has(entry)
      )
    ),
  query('status', `Status must be one of ${NOTIFICATION_STATUSES.join(', ')}`)
    .optional(OPTIONAL_QUERY)
    .custom((value: unknown) =>
      enumListFilter(value).every(
        (entry) => typeof entry === 'string' && NOTIFICATION_STATUS_SET.has(entry)
      )
    ),
  query('from', 'Enter the start date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  query('to', 'Enter the end date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  query('order', "Order must be 'upcoming' or 'recent'")
    .optional(OPTIONAL_QUERY)
    .isIn(['upcoming', 'recent']),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const raw = req.query as Record<string, unknown>;
    const { limit, offset } = pageOf(raw);

    const reminders = await listReminderPage(auth.pharmacyId, {
      patientId: raw.patientId === undefined || raw.patientId === '' ? null : String(raw.patientId),
      kinds: enumFilter(raw.kind, REMINDER_KINDS, 'the kind filter'),
      statuses: enumFilter(raw.status, NOTIFICATION_STATUSES, 'the status filter'),
      from: toDateOnlyOrNull(raw.from, 'the start date'),
      to: toDateOnlyOrNull(raw.to, 'the end date'),
      ...(raw.order === undefined || raw.order === ''
        ? {}
        : { order: toEnumMember(raw.order, ['upcoming', 'recent'] as const, 'the order') }),
      limit,
      offset,
    });

    // `status` and `notSentReason` come back on every row rather than being
    // summarised here, because the acceptance criterion is that an unsent reminder
    // is labelled as unsent *and says why*. A panel that inferred "not delivered"
    // from an empty `sentAt` would be guessing at the one thing the row states.
    sendOk(res, { reminders, limit, offset, kinds: REMINDER_KINDS });
  })
);

notificationsRoutes.post(
  '/read-all',
  authorize('notifications:read'),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    // No `runValidation`: there is nothing on this route to validate. A body is
    // not read, so a malformed one cannot reach anything.
    sendOk(res, await readAllNotifications(auth.pharmacyId, auth.userId));
  })
);

notificationsRoutes.post(
  '/refresh',
  authorize('notifications:refresh'),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    // One pass, not a drain: this is an HTTP request and a request has to return.
    // `moreDue` says whether a full batch came back, so a caller pressing the
    // button again is acting on information rather than guessing — and the
    // quarter-hourly cron picks the remainder up whatever anybody does.
    //
    // Reminders only, and deliberately not stock alerts too. Running
    // `scanStockAlerts` under this permission would let it do the work
    // `inventory:alerts:scan` exists to do, and the only way to keep that safe is
    // to pin "these two permissions have identical role sets" as an invariant —
    // a coincidence dressed as a rule.
    sendOk(res, await refreshDueReminders(auth.pharmacyId));
  })
);

// --- The bell -----------------------------------------------------------------

notificationsRoutes.get(
  '/',
  authorize('notifications:read'),
  ...pagination,
  query('type', `Type must be one of ${NOTIFICATION_TYPES.join(', ')}`)
    .optional(OPTIONAL_QUERY)
    .custom((value: unknown) =>
      enumListFilter(value).every(
        (entry) => typeof entry === 'string' && NOTIFICATION_TYPE_SET.has(entry)
      )
    ),
  booleanQuery('unreadOnly', UNREAD_LABEL),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const raw = req.query as Record<string, unknown>;
    const { limit, offset } = pageOf(raw);

    const page = await listNotificationPage(auth.pharmacyId, auth.userId, {
      types: enumFilter(raw.type, NOTIFICATION_TYPES, 'the type filter'),
      visibleTo: auth.userId,
      unreadOnly: booleanFilter(raw.unreadOnly, UNREAD_LABEL),
      limit,
      offset,
    });

    // `unread` travels with the list rather than being a second endpoint, so the
    // badge and the rows it counts cannot come from two different moments. A bell
    // showing 3 above two rows is the disagreement that makes somebody stop
    // trusting either number.
    sendOk(res, { ...page, types: NOTIFICATION_TYPES });
  })
);

notificationsRoutes.post(
  '/:id/read',
  authorize('notifications:read'),
  param('id').isUUID().withMessage('That is not a valid notification id'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const notificationId = idParam(req.params.id, 'notification');
    sendOk(res, {
      notification: await readNotification(auth.pharmacyId, auth.userId, notificationId),
    });
  })
);
