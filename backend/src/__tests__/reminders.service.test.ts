jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
}));

jest.mock('../repositories/notifications.repository', () => ({
  raiseNotification: jest.fn(),
}));

jest.mock('../repositories/patients.repository', () => ({
  findPatient: jest.fn(),
}));

jest.mock('../repositories/reminders.repository', () => ({
  listDueReminders: jest.fn(),
  listReminders: jest.fn(),
  recordReminderOutcome: jest.fn(),
}));

import type { PoolClient } from 'pg';
import { poolSql, withTransaction } from '../database/pool';
import {
  raiseNotification,
  type NewNotification,
  type NotificationRow,
} from '../repositories/notifications.repository';
import { findPatient, type PatientRow } from '../repositories/patients.repository';
import {
  listDueReminders,
  listReminders,
  recordReminderOutcome,
  type ReminderOutcome,
  type ReminderRow,
} from '../repositories/reminders.repository';
import {
  DEFAULT_REMINDER_BATCH_LIMIT,
  PATIENT_GONE_REASON,
  REMINDER_NOTIFICATION_TYPE,
  listReminderPage,
  refreshReminders,
  reminderNotificationKey,
} from '../services/reminders.service';
import {
  NO_PHONE_REASON,
  SMS_NOT_CONFIGURED_REASON,
  UNSENDABLE_PHONE_REASON,
  type SmsProvider,
} from '../services/sms';
import type { Gender } from '../utils/schema-enums';

/**
 * A refresh: what it writes, and whether what it writes is true.
 *
 * Phase 8's acceptance line is two claims — deduplication proven so a repeated
 * refresh does not re-raise the same reminder, and the unsent state proven
 * honest — and this suite is where they are asserted about the service. The
 * database half of both is section 18 of `database/tests/assertions.sql`: 18c
 * drives one dedupe key through the insert twice, 18d requires `not_sent` to be
 * refused without a reason, 18e requires a second run guarded on `pending` to
 * match nothing. What is left to prove here is that the service asks for those
 * guarantees rather than working around them.
 *
 * `services/sms.ts` is deliberately NOT mocked, following `alerts.service.test.ts`
 * and its refusal to mock `utils/fefo`. `deliverSms` is real behaviour with real
 * branches, and it is injectable by design — `refreshReminders` takes a provider —
 * so a delivery, a refusal and a transport failure are all reachable without
 * replacing the thing under test with a stub that agrees with whatever this file
 * assumed. Mocking it would make every "unsent state proven honest" assertion
 * below a statement about a fiction.
 *
 * The repositories and the pool are mocked, because what matters at this level is
 * which writes were asked for, with which keys, guards and reasons. That the
 * statements are valid SQL is `reminders.repository.test.ts` and the harness.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const OTHER_PATIENT = 'a0000000-0000-4000-8000-000000000041';
const REMINDER = 'a0000000-0000-4000-8000-0000000000c1';
const OTHER_REMINDER = 'a0000000-0000-4000-8000-0000000000c2';
const NOTIFICATION = 'a0000000-0000-4000-8000-0000000000d2';
const NOW = '2026-04-20T09:00:00.000Z';
const DUE_AT = '2026-04-20T08:30:00.000Z';
const MESSAGE = 'Your blood pressure script is due for a refill.';
const PHONE = '024 123 4567';
const NAME = 'Ama Mensah';

const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const withTransactionMock = withTransaction as jest.Mock;
const raiseMock = raiseNotification as jest.Mock;
const findPatientMock = findPatient as jest.Mock;
const listDueMock = listDueReminders as jest.Mock;
const listRemindersMock = listReminders as jest.Mock;
const recordOutcomeMock = recordReminderOutcome as jest.Mock;

/**
 * Complete rows rather than partial ones cast to the interface: if `ReminderRow`
 * or `PatientRow` grows a required field, this file stops compiling instead of
 * quietly feeding the service a row no database would ever return.
 */
function reminder(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: REMINDER,
    pharmacyId: PHARMACY,
    patientId: PATIENT,
    kind: 'refill',
    dueAt: DUE_AT,
    message: MESSAGE,
    status: 'pending',
    notSentReason: null,
    notificationId: null,
    dedupeKey: `refill:${REMINDER}`,
    createdAt: '2026-04-06T09:15:00.000Z',
    updatedAt: '2026-04-06T09:15:00.000Z',
    ...overrides,
  };
}

function patient(overrides: Partial<PatientRow> = {}): PatientRow {
  const gender: Gender | null = 'female';
  return {
    id: PATIENT,
    pharmacyId: PHARMACY,
    fullName: NAME,
    phone: PHONE,
    dateOfBirth: '1978-02-11',
    gender,
    allergies: ['Penicillin'],
    conditions: ['Hypertension'],
    medications: ['Amlodipine 5mg'],
    notes: null,
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

function notificationRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: NOTIFICATION,
    pharmacyId: PHARMACY,
    userId: null,
    type: 'refill_reminder',
    status: 'not_sent',
    title: `Refill reminder — ${NAME}`,
    body: MESSAGE,
    relatedType: 'reminder',
    relatedId: REMINDER,
    dedupeKey: reminderNotificationKey(REMINDER),
    notSentReason: SMS_NOT_CONFIGURED_REASON,
    sentAt: null,
    readAt: null,
    createdAt: '2026-04-20T09:00:00.000Z',
    updatedAt: '2026-04-20T09:00:00.000Z',
    ...overrides,
  };
}

/** A provider that accepts everything and records what it was given. */
function acceptingProvider(): SmsProvider & { sent: { to: string; body: string }[] } {
  const sent: { to: string; body: string }[] = [];
  return {
    name: 'accepting',
    sent,
    send: async (message) => {
      sent.push(message);
      return { delivered: true, sentAt: '2026-04-20T09:00:04.000Z', reference: 'V-1' };
    },
  };
}

function throwingProvider(): SmsProvider {
  return {
    name: 'throwing',
    send: async () => {
      throw new Error('ECONNREFUSED');
    },
  };
}

/** Every bell entry the refresh asked for, in the order it asked. */
function raised(): NewNotification[] {
  return raiseMock.mock.calls.map((call) => (call as unknown[])[1] as NewNotification);
}

/** Every outcome written back onto a reminder. */
function outcomes(): ReminderOutcome[] {
  return recordOutcomeMock.mock.calls.map((call) => (call as unknown[])[3] as ReminderOutcome);
}

/** The guard lists the outcomes were written under. */
function guards(): unknown[] {
  return recordOutcomeMock.mock.calls.map((call) => (call as unknown[])[4]);
}

beforeEach(() => {
  jest.clearAllMocks();
  withTransactionMock.mockImplementation(
    async (work: (client: PoolClient) => Promise<unknown>) => work(CLIENT)
  );
  listDueMock.mockResolvedValue([]);
  listRemindersMock.mockResolvedValue([]);
  findPatientMock.mockResolvedValue(patient());
  raiseMock.mockResolvedValue({ raised: true, notification: notificationRow() });
  recordOutcomeMock.mockImplementation(async (_sql, _pharmacyId, _id, _outcome, _from) =>
    reminder({ status: 'not_sent' })
  );
});

describe('refreshReminders', () => {
  it('reports an empty queue as zero of everything rather than throwing', async () => {
    await expect(refreshReminders(PHARMACY, NOW)).resolves.toEqual({
      now: NOW,
      due: 0,
      sent: 0,
      notSent: 0,
      failed: 0,
      alreadyDealt: 0,
    });
    expect(raiseMock).not.toHaveBeenCalled();
    expect(recordOutcomeMock).not.toHaveBeenCalled();
  });

  it('echoes the instant it reasoned about, so a run can be identified afterwards', async () => {
    // `now` is a parameter all the way down to `listDueReminders`, which the
    // repository records as deliberate: every reminder in one run is selected
    // against one instant, so the batch is one fact rather than a smear of clock
    // reads. The summary carrying it is what makes that inspectable from outside.
    const summary = await refreshReminders(PHARMACY, NOW);
    expect(summary.now).toBe(NOW);
    expect(listDueMock).toHaveBeenCalledWith(CLIENT, PHARMACY, NOW, DEFAULT_REMINDER_BATCH_LIMIT);
  });

  it('bounds the batch, and lets the caller narrow it but not lose the bound', async () => {
    // A month without a scheduler run is a month of reminders due at once, and one
    // transaction holding all of them is a long lock and a large rollback. The rest
    // stay `pending` and come in the next run, which is a queue working rather than
    // a loss.
    expect(DEFAULT_REMINDER_BATCH_LIMIT).toBe(50);
    await refreshReminders(PHARMACY, NOW, { limit: 5 });
    expect(listDueMock).toHaveBeenCalledWith(CLIENT, PHARMACY, NOW, 5);
  });

  it('labels a reminder nothing was sent for as not_sent, with the reason beside it', async () => {
    listDueMock.mockResolvedValue([reminder()]);

    const summary = await refreshReminders(PHARMACY, NOW);

    // The state the platform ships in: no provider is configured, so nothing was
    // attempted, and the honest record says so rather than leaving the reminder
    // `pending` where it reads as "on its way". `sms.test.ts` pins the reason; what
    // is asserted here is that the service passes it through to both writes intact.
    expect(summary).toMatchObject({ due: 1, notSent: 1, sent: 0, failed: 0 });
    expect(raised()[0]).toMatchObject({
      status: 'not_sent',
      notSentReason: SMS_NOT_CONFIGURED_REASON,
    });
  });

  it('writes the same status and the same reason onto the reminder as onto the bell entry', async () => {
    listDueMock.mockResolvedValue([reminder()]);

    await refreshReminders(PHARMACY, NOW);

    // The honesty claim, stated as an equality between two writes rather than as two
    // separate assertions that happen to agree. A bell entry saying `not_sent — no
    // provider` beside a reminder still saying `pending` is the failure this forbids:
    // the dashboard would show a reminder as due while the bell explained it had
    // already been given up on, and neither view would be wrong on its own.
    const bell = raised()[0];
    const written = outcomes()[0];
    expect(bell).toBeDefined();
    expect(written).toBeDefined();
    expect({
      bellStatus: bell?.status,
      bellReason: bell?.notSentReason,
      reminderStatus: written?.status,
      reminderReason: written?.notSentReason,
    }).toEqual({
      bellStatus: 'not_sent',
      bellReason: SMS_NOT_CONFIGURED_REASON,
      reminderStatus: 'not_sent',
      reminderReason: SMS_NOT_CONFIGURED_REASON,
    });
  });

  it('never produces a not_sent with nothing beside it, on any path out of the refresh', async () => {
    // The acceptance line as an invariant rather than as four examples. Every
    // disposition the service can reach is driven through one assertion: whatever
    // status was written, either it is `sent` or there is a reason with it. The
    // schema refuses the pair when the reason is missing, so a violation here would
    // be a 23514 in production rather than a bad row — but the invariant is what
    // makes that a guarantee instead of a coincidence of the branches.
    const cases: { name: string; row: PatientRow | null; provider: SmsProvider | null }[] = [
      { name: 'no provider', row: patient(), provider: null },
      { name: 'no phone number', row: patient({ phone: null }), provider: null },
      { name: 'unsendable number', row: patient({ phone: '024123456a' }), provider: null },
      { name: 'patient gone', row: null, provider: null },
      { name: 'transport failure', row: patient(), provider: throwingProvider() },
      { name: 'delivered', row: patient(), provider: acceptingProvider() },
    ];

    for (const testCase of cases) {
      jest.clearAllMocks();
      withTransactionMock.mockImplementation(
        async (work: (client: PoolClient) => Promise<unknown>) => work(CLIENT)
      );
      listDueMock.mockResolvedValue([reminder()]);
      findPatientMock.mockResolvedValue(testCase.row);
      raiseMock.mockResolvedValue({ raised: true, notification: notificationRow() });
      recordOutcomeMock.mockImplementation(async () => reminder({ status: 'not_sent' }));

      await refreshReminders(PHARMACY, NOW, { provider: testCase.provider });

      for (const [bell, written] of [
        [raised()[0], outcomes()[0]] as const,
      ]) {
        expect({ case: testCase.name, bellStatus: bell?.status, bellReason: bell?.notSentReason })
          .toEqual({
            case: testCase.name,
            bellStatus: bell?.status,
            bellReason:
              bell?.status === 'sent' ? null : expect.any(String) as string | null,
          });
        // The mirror image: a `sent` entry carries the instant the provider reported,
        // and an undelivered one carries none. Neither half is decorative — `sent`
        // with no timestamp is a claim nobody can check, and `not_sent` with one would
        // say a message went out at the same moment as saying it did not.
        expect({ case: testCase.name, bellSentAt: bell?.sentAt }).toEqual({
          case: testCase.name,
          bellSentAt: bell?.status === 'sent' ? expect.any(String) : null,
        });
        expect({
          case: testCase.name,
          reminderStatus: written?.status,
          reminderReason: written?.notSentReason,
        }).toEqual({
          case: testCase.name,
          reminderStatus: bell?.status,
          reminderReason: bell?.notSentReason,
        });
      }
    }
  });

  it('guards the outcome on pending, which is what stops two runs dealing with one reminder', async () => {
    listDueMock.mockResolvedValue([reminder()]);

    await refreshReminders(PHARMACY, NOW);

    // Pinned as the parameter it is rather than as a behaviour, because the guard is
    // the repository's and section 18e executes it against a real server. What this
    // asserts is the service's half: that it asks for `['pending']` and not for
    // something wider. A guard of `['pending', 'not_sent']` would let a second run
    // rewrite a reminder the first had already given up on, and a retry that changes
    // the reason is a backfill's business, not a scheduler's.
    expect(guards()).toEqual([['pending']]);
  });

  it('counts a refused guard as already dealt with, and not as a reminder this run handled', async () => {
    listDueMock.mockResolvedValue([reminder()]);
    recordOutcomeMock.mockResolvedValue(null);

    const summary = await refreshReminders(PHARMACY, NOW);

    // The overlapping-run case, and the reason `alreadyDealt` is its own count rather
    // than being folded into `notSent`. A summary reporting one reminder as handled by
    // this run when another run handled it is a summary that cannot be reconciled
    // against the bell, and the caller — a scheduler log, a dashboard button — would
    // be telling somebody that work was done that this run did not do.
    expect(summary).toEqual({
      now: NOW,
      due: 1,
      sent: 0,
      notSent: 0,
      failed: 0,
      alreadyDealt: 1,
    });
  });

  it('re-raises nothing on a second refresh, because the first left nothing pending', async () => {
    listDueMock.mockResolvedValueOnce([reminder()]).mockResolvedValueOnce([]);
    recordOutcomeMock.mockImplementation(async () => reminder({ status: 'not_sent' }));

    const first = await refreshReminders(PHARMACY, NOW);
    const second = await refreshReminders(PHARMACY, '2026-04-20T10:00:00.000Z');

    // The acceptance line, at the level this suite can honestly reach: the second
    // refresh finds nothing because the first moved the reminder out of `pending`,
    // and `listDueReminders` selects on that literal. That the row really does leave
    // the partial index is 18e's, against a real server; asserting it here would
    // mean asserting something about a mock.
    expect(first).toMatchObject({ due: 1, notSent: 1 });
    expect(second).toMatchObject({ due: 0, notSent: 0, alreadyDealt: 0 });
    expect(raiseMock).toHaveBeenCalledTimes(1);
    expect(recordOutcomeMock).toHaveBeenCalledTimes(1);
  });

  it('keys the bell entry to the reminder alone, so two runs that both see it still produce one entry', async () => {
    listDueMock.mockResolvedValue([reminder()]);

    await refreshReminders(PHARMACY, NOW);
    await refreshReminders(PHARMACY, '2026-04-20T10:00:00.000Z');

    // The other half of deduplication, covering the case the test above deliberately
    // does not: two runs overlapping, both selecting the same pending reminder before
    // either writes an outcome. The guard means only one writes; this means only one
    // bell entry exists whichever wins, because `raiseNotification` conflicts on
    // `(pharmacy_id, dedupe_key)`. Same key both times is the whole claim.
    expect(raiseMock).toHaveBeenCalledTimes(2);
    expect(raised()[0]?.dedupeKey).toBe(reminderNotificationKey(REMINDER));
    expect(raised()[1]?.dedupeKey).toBe(raised()[0]?.dedupeKey);
    expect(raised()[0]?.dedupeKey).toBe(`reminder:${REMINDER}`);
  });

  it('gives two reminders for the same patient two bell entries, because they are two facts', async () => {
    listDueMock.mockResolvedValue([
      reminder(),
      reminder({ id: OTHER_REMINDER, kind: 'appointment', message: 'Your review is on Monday.' }),
    ]);

    await refreshReminders(PHARMACY, NOW);

    // The contrast that makes the key above meaningful. Keyed to the patient, or to
    // the day, or to the kind, a second reminder for the same person would be
    // swallowed by the first — a refill reminder silently suppressing an appointment
    // one, which is the failure mode a dedupe key that is too wide produces and it
    // looks like nothing at all from the counter.
    expect(raised()).toHaveLength(2);
    expect(raised()[0]?.dedupeKey).toBe(`reminder:${REMINDER}`);
    expect(raised()[1]?.dedupeKey).toBe(`reminder:${OTHER_REMINDER}`);
  });

  it('says sent, and clears the reason, when a provider accepts the message', async () => {
    const provider = acceptingProvider();
    listDueMock.mockResolvedValue([reminder({ status: 'not_sent', notSentReason: SMS_NOT_CONFIGURED_REASON })]);

    const summary = await refreshReminders(PHARMACY, NOW, { provider });

    // The retry that succeeds. `notSentReason: null` is supplied explicitly rather
    // than omitted, because the repository's flagged case distinguishes "clear it"
    // from "leave it" and omitting it would leave a sent reminder saying "no SMS
    // provider is configured" beside it — a contradiction the check constraint
    // permits and nobody wants to read in a bell.
    expect(summary).toMatchObject({ due: 1, sent: 1, notSent: 0, failed: 0 });
    expect(raised()[0]).toMatchObject({
      status: 'sent',
      notSentReason: null,
      // The provider's own instant, not a clock read taken here. `services/sms.ts`
      // records why: this process only handed the message over, so a local timestamp
      // would claim to know when a handset received something.
      sentAt: '2026-04-20T09:00:04.000Z',
    });
    expect(outcomes()[0]).toEqual({
      status: 'sent',
      notSentReason: null,
      notificationId: NOTIFICATION,
    });
    expect(provider.sent).toEqual([{ to: '+233241234567', body: MESSAGE }]);
  });

  it('says failed rather than not_sent when a provider was reached and did not complete', async () => {
    listDueMock.mockResolvedValue([reminder()]);

    const summary = await refreshReminders(PHARMACY, NOW, { provider: throwingProvider() });

    // The distinction the status enum exists to carry, asserted at the service
    // boundary because this is where it would be lost: collapsing `failed` into
    // `not_sent` here is one word, and it removes the difference between "nothing was
    // attempted, and the reason is a fact about this pharmacy" and "a provider was
    // reached and said no, which is a different problem with a different owner".
    expect(summary).toMatchObject({ due: 1, failed: 1, notSent: 0, sent: 0 });
    expect(raised()[0]?.status).toBe('failed');
    expect(outcomes()[0]?.status).toBe('failed');
    expect(typeof outcomes()[0]?.notSentReason).toBe('string');
  });

  it('reports a patient with no phone number as a fact about the record, not about the configuration', async () => {
    findPatientMock.mockResolvedValue(patient({ phone: null }));
    listDueMock.mockResolvedValue([reminder()]);

    await refreshReminders(PHARMACY, NOW, { provider: acceptingProvider() });

    // Even with a provider that would accept anything, the record's own gap wins —
    // the precedence `sms.test.ts` pins, asserted here because it is the service that
    // decides to hand the null over rather than short-circuiting. Actionable is the
    // point: a pharmacist can fix this by asking the patient at the next visit, and
    // until then the reminder is in the bell where somebody can telephone instead.
    expect(raised()[0]).toMatchObject({ status: 'not_sent', notSentReason: NO_PHONE_REASON });
    expect(raised()[0]?.notSentReason).not.toBe(SMS_NOT_CONFIGURED_REASON);
  });

  it('reports an unsendable number the same way, because a typo is fixable and a missing provider is not', async () => {
    findPatientMock.mockResolvedValue(patient({ phone: '024123456a' }));
    listDueMock.mockResolvedValue([reminder()]);

    await refreshReminders(PHARMACY, NOW);

    expect(raised()[0]).toMatchObject({
      status: 'not_sent',
      notSentReason: UNSENDABLE_PHONE_REASON,
    });
  });

  it('deals with a reminder whose patient has gone without aborting the batch', async () => {
    listDueMock.mockResolvedValue([
      reminder(),
      reminder({ id: OTHER_REMINDER, patientId: OTHER_PATIENT }),
    ]);
    findPatientMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(patient({ id: OTHER_PATIENT, fullName: 'Kwame Osei' }));

    const summary = await refreshReminders(PHARMACY, NOW);

    // `patient_id` cascades, so this is not reachable through the application. It is
    // handled anyway because the alternative — one orphaned row throwing out of a
    // fifty-reminder batch — turns a data curiosity into a scheduler that stops
    // working, and every reminder behind the bad one stays `pending` forever.
    expect(summary).toMatchObject({ due: 2, notSent: 2, failed: 0 });
    expect(raised()).toHaveLength(2);
    expect(raised()[0]).toMatchObject({
      status: 'not_sent',
      notSentReason: PATIENT_GONE_REASON,
      title: 'Refill reminder — patient record missing',
    });
    expect(raised()[1]).toMatchObject({ title: `Refill reminder — Kwame Osei` });
  });

  it('attaches the bell entry it raised, and nothing when another run already had', async () => {
    listDueMock.mockResolvedValue([reminder()]);

    await refreshReminders(PHARMACY, NOW);
    expect(outcomes()[0]?.notificationId).toBe(NOTIFICATION);

    raiseMock.mockResolvedValue({ raised: false, notification: null });
    await refreshReminders(PHARMACY, NOW);

    // `do nothing returning` gives no row on a conflict, so there is no id to attach
    // — and null is the right thing to write, because `recordReminderOutcome`
    // coalesces it and the winning run's id stays put. Writing a fabricated id here
    // would point the reminder at a bell entry about something else.
    expect(outcomes()[1]?.notificationId).toBe(null);
  });

  it('does the whole batch in one transaction, so the summary describes what landed', async () => {
    listDueMock.mockResolvedValue([
      reminder(),
      reminder({ id: OTHER_REMINDER }),
      reminder({ id: 'a0000000-0000-4000-8000-0000000000c3' }),
    ]);

    await refreshReminders(PHARMACY, NOW);

    // Following `scanStockAlerts`. The transaction is not what makes the refresh safe
    // to repeat — the dedupe keys and the guard do that, per row — it is what makes
    // the returned counts a true description. A run that dealt with two and then
    // failed on the third would otherwise report two and leave a caller believing the
    // batch was finished.
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(raiseMock).toHaveBeenCalledTimes(3);
    expect(recordOutcomeMock).toHaveBeenCalledTimes(3);
  });

  it('broadcasts rather than targeting whoever opened the bell first', async () => {
    listDueMock.mockResolvedValue([reminder()]);

    await refreshReminders(PHARMACY, NOW);

    // `userId: null` is how the repository spells "every staff member sees this". A
    // patient reminder is not the property of whoever triggered the refresh, and
    // targeting it would mean a reminder raised by a scheduler cron belonged to
    // nobody and appeared in no bell at all.
    expect(raised()[0]?.userId).toBe(null);
  });

  it('puts the message the patient would have received in the bell verbatim, and names the reminder', async () => {
    listDueMock.mockResolvedValue([reminder()]);

    await refreshReminders(PHARMACY, NOW);

    // The same sentence rather than a paraphrase, which matters most when nothing was
    // sent: a pharmacist reads the bell entry aloud to the patient instead, and a
    // paraphrase is a second version of clinical text that nobody reviewed.
    expect(raised()[0]).toMatchObject({
      body: MESSAGE,
      relatedType: 'reminder',
      relatedId: REMINDER,
    });
  });

  it('gives each kind its own bell entry type and title, so the two read apart at a glance', async () => {
    listDueMock.mockResolvedValue([
      reminder(),
      reminder({ id: OTHER_REMINDER, kind: 'appointment' }),
    ]);

    await refreshReminders(PHARMACY, NOW);

    // Both types already exist in `notification_type`, so this is a mapping rather
    // than an invention — and it is pinned as a total record so adding a third
    // `reminder_kind` is a compile error here instead of a bell entry with no type.
    expect(REMINDER_NOTIFICATION_TYPE).toEqual({
      refill: 'refill_reminder',
      appointment: 'appointment_reminder',
    });
    expect(raised()[0]).toMatchObject({ type: 'refill_reminder', title: `Refill reminder — ${NAME}` });
    expect(raised()[1]).toMatchObject({
      type: 'appointment_reminder',
      title: `Appointment reminder — ${NAME}`,
    });
  });

  it('reads the patient inside the transaction it writes in, so the number cannot change underneath it', async () => {
    listDueMock.mockResolvedValue([reminder()]);

    await refreshReminders(PHARMACY, NOW);

    // Asserted on the client the lookup was given rather than on the ordering of
    // calls. A patient's phone number edited between the read and the write would
    // mean the bell entry describes a destination that was never attempted, and
    // reading inside the same transaction is what makes the two writes and the lookup
    // one view of the world.
    expect(findPatientMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PATIENT);
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      CLIENT,
      PHARMACY,
      REMINDER,
      expect.any(Object),
      ['pending']
    );
    expect(raiseMock).toHaveBeenCalledWith(CLIENT, expect.any(Object));
  });
});

describe('reminderNotificationKey', () => {
  it('is keyed to the reminder and to nothing else', () => {
    // Two reminders for one patient, one slot or one prescription are two bell
    // entries, and a key that carried anything but the reminder's own id would merge
    // them. Pinned as a shape rather than only as the two uses above, because the
    // shape is what a future caller has to match.
    expect(reminderNotificationKey(REMINDER)).toBe(`reminder:${REMINDER}`);
    expect(reminderNotificationKey(REMINDER)).toBe(reminderNotificationKey(REMINDER));
    expect(reminderNotificationKey(REMINDER)).not.toBe(reminderNotificationKey(OTHER_REMINDER));
  });
});

describe('listReminderPage', () => {
  it('reads persisted rows through the pool rather than deriving a list at request time', async () => {
    const filters = { order: 'upcoming' as const, limit: 20, offset: 0 };
    listRemindersMock.mockResolvedValue([reminder()]);

    await expect(listReminderPage(PHARMACY, filters)).resolves.toEqual([reminder()]);

    // A read and not a re-derivation, which is the other half of Phase 8's line about
    // the bell: a reminder re-computed at request time would show as due the moment
    // the rule said so, including after it had been sent, superseded or given up on,
    // and the dashboard would disagree with its own history. The filters are passed
    // through untouched, so the ordering and paging the caller asked for are the
    // ordering and paging they get.
    expect(listRemindersMock).toHaveBeenCalledWith(poolSql, PHARMACY, filters);
  });
});

describe('the module surface', () => {
  it('exports the refresh, the read, the key builder and the constants, and no way to write a status directly', async () => {
    // A service that exported a "mark this reminder sent" function would be a second
    // path to the dishonest state migration 0005 exists to make impossible: a row
    // claiming a patient was told when nothing was attempted. Statuses here are only
    // ever produced by an outcome from `deliverSms`, which is why the surface is this
    // short. Filtered the same way `consultations.repository.test.ts` filters, because
    // a compiled ES module carries `__esModule` and a default that are not exports of
    // this module's own making.
    const exported = Object.keys(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../services/reminders.service') as Record<string, unknown>
    )
      .filter((name) => name !== '__esModule' && name !== 'default')
      .sort();

    expect(exported).toEqual([
      'DEFAULT_REMINDER_BATCH_LIMIT',
      'PATIENT_GONE_REASON',
      'REMINDER_NOTIFICATION_TYPE',
      'listReminderPage',
      'refreshReminders',
      'reminderNotificationKey',
    ]);
  });
});
