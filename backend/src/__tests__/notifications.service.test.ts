jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  // Mocked so that *not* calling it is an assertion. `listNotificationPage`'s header
  // says both reads happen outside a transaction and gives the reason; a suite that
  // never imported `withTransaction` could not tell that from a suite where the
  // service had quietly grown a transaction around a badge.
  withTransaction: jest.fn(),
}));

jest.mock('../repositories/notifications.repository', () => ({
  countUnread: jest.fn(),
  listNotifications: jest.fn(),
  markAllRead: jest.fn(),
  markRead: jest.fn(),
}));

// The batch is replaced but the real batch limit is kept, following
// `run-reminders.test.ts` exactly. Expressing "a full batch" as
// `DEFAULT_REMINDER_BATCH_LIMIT` rather than as the literal 50 is what makes the
// `moreDue` boundary a test about the limit rather than about a number that happens
// to equal it today — and this suite is the second of the two callers that compare
// against it, so a drift here would be a drift in the same direction.
jest.mock('../services/reminders.service', () => {
  const actual = jest.requireActual<typeof import('../services/reminders.service')>(
    '../services/reminders.service'
  );
  return {
    DEFAULT_REMINDER_BATCH_LIMIT: actual.DEFAULT_REMINDER_BATCH_LIMIT,
    refreshReminders: jest.fn(),
  };
});

jest.mock('../utils/clock', () => ({
  // A spy rather than fake timers: the claim is which instant was stamped onto the
  // row and handed to the batch, and both are about the call rather than the clock.
  nowIso: jest.fn(),
}));

import { poolSql, withTransaction } from '../database/pool';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  type NotificationFilters,
  type NotificationRow,
} from '../repositories/notifications.repository';
import {
  listNotificationPage,
  readAllNotifications,
  readNotification,
  refreshDueReminders,
} from '../services/notifications.service';
import {
  DEFAULT_REMINDER_BATCH_LIMIT,
  refreshReminders,
  type RefreshSummary,
} from '../services/reminders.service';
// Not mocked, following the house rule about modules with real branches. The reason
// below is the sentence a patient's reminder actually carries in production today,
// so the fixture row is one the system could produce rather than one invented here.
import { SMS_NOT_CONFIGURED_REASON } from '../services/sms';
import { nowIso } from '../utils/clock';
import { HttpError } from '../utils/http';

/**
 * The bell, and the button that runs the scheduler by hand.
 *
 * Four claims are under test and none of them is "does the service call the
 * repository".
 *
 * **Nothing is derived.** `NotificationView` is `NotificationRow` and the module
 * header states there is no derivation anywhere in it. That is Phase 8's acceptance
 * criterion rather than a style choice — a reminder re-computed at request time
 * would show a refill as due after it had been sent, superseded or dealt with, and
 * the bell would then disagree with its own history. Asserting the returned rows are
 * the rows the repository produced, key for key, is the only way to see that hold:
 * a service that started adding `isBroadcast` beside `userId` would be deriving, and
 * would still pass a test that checked a title.
 *
 * **The badge travels with the list.** `unread` comes from a count over the whole
 * table rather than from the length of a page, and the two are fetched together. The
 * test makes them disagree on purpose — two rows beside a badge of seven — because a
 * suite where they happen to be equal cannot tell a count from a `.length`.
 *
 * **The numbers are honest in both directions.** A second "mark all read" reports
 * zero, and the service passes that zero through rather than restating a total; and
 * the refresh summary comes back whole, with `sent: 0` visible beside `notSent: 12`.
 * Collapsing those into "processed 12" is the specific lie the header names, and it
 * is a collapse this module could perform without any other module changing.
 *
 * **The batch takes no provider from the caller.** `refreshReminders` has a third
 * `options` parameter that can inject an SMS provider. This service calls it with two
 * arguments, so nothing arriving over HTTP can reach that parameter — which matters
 * because `notifications:refresh` is the one permission on this router that counter
 * staff do not hold, and an injectable provider would make the permission the only
 * thing standing between a request and a message sent to a patient.
 *
 * The batch itself — the dedupe, the guarded outcome, the six dispositions — is
 * proven against the real thing by `reminders.service.test.ts`, and the visibility
 * rule that makes a null from `markRead` ambiguous is SQL, proven by section 11 of
 * the harness and by `notifications.repository.test.ts`. Neither is re-tested here.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a0000000-0000-4000-8000-000000000002';
const NOTIFICATION = 'a0000000-0000-4000-8000-000000000070';

/** A second member of staff, for the row that is not the caller's to read. */
const COLLEAGUE = 'a0000000-0000-4000-8000-000000000003';

/** A second bell entry, so a page is a page rather than one row repeated. */
const OTHER_NOTIFICATION = 'a0000000-0000-4000-8000-000000000071';

/** What `nowIso` answers for the whole suite, so "just now" is a fixed point. */
const NOW = '2026-09-05T09:30:00.000Z';

const withTransactionMock = withTransaction as jest.Mock;
const listMock = listNotifications as jest.Mock;
const countMock = countUnread as jest.Mock;
const readMock = markRead as jest.Mock;
const readAllMock = markAllRead as jest.Mock;
const refreshMock = refreshReminders as jest.Mock;
const nowMock = nowIso as jest.Mock;

/**
 * Complete rows rather than partial ones cast to the interface: if `NotificationRow`
 * grows a required field this file stops compiling, instead of quietly feeding the
 * service a row no database would ever return.
 *
 * The default is the row production actually holds today — `not_sent`, with the
 * reason beside it — because that is the state the acceptance criterion is about.
 */
function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: NOTIFICATION,
    pharmacyId: PHARMACY,
    // Null is how the table spells a broadcast: every member of staff sees it, and
    // whoever reads it first reads it for everybody.
    userId: null,
    type: 'refill_reminder',
    status: 'not_sent',
    title: 'A refill is due',
    body: 'Kofi Mensah — paracetamol 500mg, due 8 September 2026',
    relatedType: 'prescription',
    relatedId: 'a0000000-0000-4000-8000-000000000080',
    dedupeKey: 'reminder:a0000000-0000-4000-8000-000000000090',
    notSentReason: SMS_NOT_CONFIGURED_REASON,
    sentAt: null,
    readAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** What the bell asks for: everything, first page. */
function filters(overrides: Partial<NotificationFilters> = {}): NotificationFilters {
  return {
    types: [],
    visibleTo: USER,
    limit: 50,
    offset: 0,
    ...overrides,
  };
}

/**
 * A batch summary as production produces one today.
 *
 * `sent: 0` beside `notSent: 12` is the shape the whole suite is arranged around:
 * no provider is configured, so every reminder dealt with is dealt with as not sent,
 * and a summary that hid the zero would read as twelve patients told.
 */
function summary(overrides: Partial<RefreshSummary> = {}): RefreshSummary {
  return {
    now: NOW,
    due: 12,
    sent: 0,
    notSent: 12,
    failed: 0,
    alreadyDealt: 0,
    ...overrides,
  };
}

/**
 * The filters the bell handed to the repository.
 *
 * A named guard rather than `mock.calls[0]?.[2]`, which reads like a broken service
 * when the real cause is a test that expected a read and did not get one.
 */
function filtersOf(): NotificationFilters {
  const first = listMock.mock.calls[0];
  if (first === undefined) throw new Error('listNotifications was never called');
  return (first as unknown[])[2] as NotificationFilters;
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string
): Promise<HttpError> {
  const thrown = await promise.then(
    () => null,
    (error: unknown) => error
  );
  if (!(thrown instanceof HttpError)) {
    throw new Error(
      `expected an HttpError ${status}/${code}, got ` +
        (thrown === null ? 'a promise that resolved' : String(thrown))
    );
  }
  expect(thrown.status).toBe(status);
  expect(thrown.code).toBe(code);
  return thrown;
}

beforeEach(() => {
  nowMock.mockReturnValue(NOW);
  listMock.mockResolvedValue([row()]);
  countMock.mockResolvedValue(3);
  readMock.mockResolvedValue(row({ readAt: NOW }));
  readAllMock.mockResolvedValue(3);
  refreshMock.mockResolvedValue(summary());
});

describe('the bell', () => {
  it('returns the rows the table holds, with nothing derived beside them', async () => {
    const stored = [
      row(),
      row({ id: OTHER_NOTIFICATION, userId: COLLEAGUE, type: 'stock_reorder' }),
    ];
    listMock.mockResolvedValue(stored);

    const page = await listNotificationPage(PHARMACY, USER, filters());

    // `toStrictEqual` over the whole array rather than a check on one field: the
    // claim is that the view *is* the row, so a key added anywhere — `shared`,
    // `isBroadcast`, a computed `due` — fails here rather than passing unnoticed
    // until a frontend starts reading it.
    expect(page.notifications).toStrictEqual(stored);
  });

  it('keeps the reason an unsent reminder was not sent on the row it belongs to', async () => {
    listMock.mockResolvedValue([
      row({ status: 'not_sent', notSentReason: SMS_NOT_CONFIGURED_REASON, sentAt: null }),
      row({ id: OTHER_NOTIFICATION, status: 'sent', notSentReason: null, sentAt: NOW, readAt: null }),
    ]);

    const page = await listNotificationPage(PHARMACY, USER, filters());

    // Both halves of the honesty line, in one page: the unsent row says it was not
    // sent and why, and the sent row carries no reason beside a delivery that
    // happened. A service that summarised these into a count would leave a panel
    // guessing at the one thing each row states.
    expect(page.notifications).toStrictEqual([
      expect.objectContaining({ status: 'not_sent', notSentReason: SMS_NOT_CONFIGURED_REASON }),
      expect.objectContaining({ status: 'sent', notSentReason: null, sentAt: NOW }),
    ]);
  });

  it('counts the badge over the whole table rather than over the page it returned', async () => {
    // Two rows beside a badge of seven. A suite where the two are equal cannot tell
    // `countUnread` from `notifications.length`, and the difference is the one that
    // stops a badge falling as somebody scrolls.
    listMock.mockResolvedValue([row(), row({ id: OTHER_NOTIFICATION })]);
    countMock.mockResolvedValue(7);

    const page = await listNotificationPage(PHARMACY, USER, filters({ limit: 2 }));

    expect(page.unread).toBe(7);
    expect(page.notifications).toHaveLength(2);
    // Scoped to the caller, and to the caller alone: the count is not a pharmacy-wide
    // total, because `read_at` is shared and a badge has to mean "rows you can see
    // that nobody has read".
    expect(countMock).toHaveBeenCalledWith(poolSql, PHARMACY, USER);
  });

  it('fetches the page and the badge together, and opens no transaction to do it', async () => {
    await listNotificationPage(PHARMACY, USER, filters());

    expect(listMock).toHaveBeenCalledWith(poolSql, PHARMACY, filters());
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('echoes the paging it was given rather than restating a default', async () => {
    const page = await listNotificationPage(PHARMACY, USER, filters({ limit: 20, offset: 40 }));

    expect({ limit: page.limit, offset: page.offset }).toStrictEqual({ limit: 20, offset: 40 });
    expect(listMock).toHaveBeenCalledWith(
      poolSql,
      PHARMACY,
      expect.objectContaining({ limit: 20, offset: 40 })
    );
  });

  it('hands the filters over unmodified, so a widened scope would be the caller doing it', async () => {
    const asked = filters({ types: ['stock_expiry', 'product_recall'], unreadOnly: true });

    await listNotificationPage(PHARMACY, USER, asked);

    // `toStrictEqual` rather than `toEqual`: `unreadOnly: false` and an absent
    // `unreadOnly` are different claims, and the repository folds only the second
    // into "nobody asked about the read ones".
    expect(filtersOf()).toStrictEqual(asked);
  });
});

describe('marking one read', () => {
  it('stamps the read with the request clock rather than with the one in the database', async () => {
    await readNotification(PHARMACY, USER, NOTIFICATION);

    // The instant is an argument, not `now()` in the statement, so it agrees with
    // everything else written in the same request — which is what makes a timeline
    // assembled from several tables sortable.
    expect(readMock).toHaveBeenCalledWith(poolSql, PHARMACY, USER, NOTIFICATION, NOW);
    expect(nowMock).toHaveBeenCalled();
  });

  it('returns the row as the table now holds it', async () => {
    const stamped = row({ readAt: NOW, updatedAt: NOW });
    readMock.mockResolvedValue(stamped);

    await expect(readNotification(PHARMACY, USER, NOTIFICATION)).resolves.toStrictEqual(stamped);
  });

  it('answers 404 for a null, and says nothing that would tell the two causes apart', async () => {
    readMock.mockResolvedValue(null);

    const thrown = await expectHttpError(
      readNotification(PHARMACY, USER, NOTIFICATION),
      404,
      'not_found'
    );

    expect(thrown.message).toBe('No notification matches that id');
    // A null is either a row that does not exist or one aimed at a different member
    // of staff. The scoping that makes those one answer is SQL, and it is the
    // repository's; what this module owes is that it adds nothing on top — no
    // `details` naming an owner, no second sentence for the second cause — because
    // either would be a way to enumerate whose notifications exist.
    expect(thrown.details).toBeUndefined();
  });
});

describe('marking all read', () => {
  it('reports how many this call read, and passes a zero on a second click straight through', async () => {
    readAllMock.mockResolvedValue(4);
    await expect(readAllNotifications(PHARMACY, USER)).resolves.toStrictEqual({ read: 4 });

    // Zero on the second click, because `markAllRead` is scoped to `read_at is null`.
    // A service that answered the total instead would report the same number twice
    // and read as though four more rows had been cleared.
    readAllMock.mockResolvedValue(0);
    await expect(readAllNotifications(PHARMACY, USER)).resolves.toStrictEqual({ read: 0 });

    expect(readAllMock).toHaveBeenLastCalledWith(poolSql, PHARMACY, USER, NOW);
  });
});

describe('running the scheduler by hand', () => {
  it('returns the summary whole, with zero sent visible beside the number not sent', async () => {
    const batch = summary({ due: 12, sent: 0, notSent: 12 });
    refreshMock.mockResolvedValue(batch);

    const result = await refreshDueReminders(PHARMACY);

    // Every key, in full. `sent`, `notSent`, `failed` and `alreadyDealt` are four
    // different facts and collapsing them into one count is the lie the header names:
    // "processed 12 reminders" is a sentence an operator would believe and a patient
    // would not.
    expect(result.summary).toStrictEqual(batch);
    expect(result.summary).toStrictEqual({
      now: NOW,
      due: 12,
      sent: 0,
      notSent: 12,
      failed: 0,
      alreadyDealt: 0,
    });
  });

  it.each([
    [0, false],
    [1, false],
    [DEFAULT_REMINDER_BATCH_LIMIT - 1, false],
    [DEFAULT_REMINDER_BATCH_LIMIT, true],
    [DEFAULT_REMINDER_BATCH_LIMIT + 1, true],
  ])('says there is more due on a batch of %i only when the batch was full', async (due, more) => {
    refreshMock.mockResolvedValue(summary({ due }));

    // One pass rather than a drain, because this is an HTTP request and a request has
    // to return. The boundary is `>=` against the same constant the batch was limited
    // by, so a full batch reads as "there may be more" and a short one as "that was
    // everything" — and the cron picks the remainder up whatever anybody does.
    await expect(refreshDueReminders(PHARMACY)).resolves.toStrictEqual({
      summary: summary({ due }),
      moreDue: more,
    });
  });

  it('runs the batch at the request instant and takes no provider from the caller', async () => {
    await refreshDueReminders(PHARMACY);

    // Two arguments and no third. `refreshReminders`'s `options` can inject an SMS
    // provider, and `toHaveBeenCalledWith` fails on a call carrying one — including
    // an explicit `undefined` — so this pins the arity rather than merely the values.
    expect(refreshMock).toHaveBeenCalledWith(PHARMACY, NOW);
  });
});
