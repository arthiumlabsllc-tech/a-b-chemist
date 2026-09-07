import { poolSql, withTransaction, type Sql } from '../database/pool';
import {
  raiseNotification,
  type NewNotification,
} from '../repositories/notifications.repository';
import { findPatient, type PatientRow } from '../repositories/patients.repository';
import {
  listDueReminders,
  listReminders,
  recordReminderOutcome,
  type ReminderFilters,
  type ReminderRow,
} from '../repositories/reminders.repository';
import type { NotificationType, ReminderKind } from '../utils/schema-enums';
import { configuredSmsProvider, deliverSms, type SmsOutcome, type SmsProvider } from './sms';

/**
 * Turning a reminder into something a member of staff can see, and recording
 * honestly whether the patient was told.
 *
 * This is the module Phase 8's two acceptance lines are about. Deduplication is
 * proven by running a refresh twice and requiring the second to re-raise nothing;
 * the unsent state is proven honest by every path out of `dealWithReminder`
 * writing a status and a reason together, with the schema refusing the pair when
 * the reason is missing.
 *
 * ## The three writes, and why they are in this order
 *
 * One reminder becomes one attempt, one bell entry and one outcome:
 *
 *   1. `deliverSms` decides whether the patient was told. It never throws for an
 *      ordinary refusal — no provider, no phone number, an unsendable number — so
 *      every one of those arrives as an outcome with a sentence beside it rather
 *      than as an exception that would leave the reminder `pending`.
 *   2. `raiseNotification` puts it in the bell, deduplicated on a key derived from
 *      the reminder's own id.
 *   3. `recordReminderOutcome` writes the status, the reason and the bell entry's
 *      id back onto the reminder, guarded on `pending`.
 *
 * The order is forced rather than chosen: the notification has to carry the
 * outcome's status, so the attempt comes first; and the reminder has to carry the
 * notification's id, so the outcome comes last.
 *
 * ## What the guard does and does not make safe
 *
 * Two overlapping scheduler runs — a slow tick, a restart, a cron that fired
 * twice — both select the same pending reminders. The guard on step 3 means only
 * one of them writes an outcome, and the dedupe key on step 2 means only one bell
 * entry exists whichever wins. So the *record* cannot be doubled, and a repeated
 * refresh cannot re-raise a reminder.
 *
 * What the guard does not prevent is both runs reaching step 1 for the same
 * reminder before either reaches step 3, which is two attempts at one message.
 * Today that is inert, because `configuredSmsProvider` returns null and nothing
 * is ever sent. It stops being inert the day A&B chooses an aggregator, and
 * closing it properly needs a claim the schema does not currently have — a
 * `pg_advisory_xact_lock` on the reminder id, or a column of its own. Recorded
 * here rather than solved speculatively, because the fix is a decision to make
 * against a real provider's retry behaviour and not against a guess.
 */

/** Which bell entry a reminder becomes. Both kinds already exist in the enum. */
export const REMINDER_NOTIFICATION_TYPE: Record<ReminderKind, NotificationType> = {
  refill: 'refill_reminder',
  appointment: 'appointment_reminder',
};

/** The bell entry's title, so a refill and an appointment read apart at a glance. */
const REMINDER_TITLE: Record<ReminderKind, string> = {
  refill: 'Refill reminder',
  appointment: 'Appointment reminder',
};

/**
 * How many reminders one scheduler run deals with.
 *
 * A bound rather than "everything due", because a pharmacy that has not run the
 * scheduler for a month has a month of reminders due at once and one transaction
 * holding all of them is a long lock and a large rollback. The remainder stays
 * `pending` and is picked up by the next run, which is the correct behaviour for a
 * queue rather than a loss.
 */
export const DEFAULT_REMINDER_BATCH_LIMIT = 50;

/**
 * Why a reminder whose patient has gone is `not_sent` rather than an error.
 *
 * `reminders.patient_id` cascades, so this is not reachable through the
 * application: deleting a patient deletes their reminders. It is handled anyway
 * because the alternative is one orphaned row aborting a batch of fifty, and
 * because a reason written down is a fact somebody can check while an exception
 * in a scheduler log is a thing nobody reads.
 */
export const PATIENT_GONE_REASON =
  'The patient record this reminder belongs to no longer exists.';

/**
 * The bell entry's dedupe key: one reminder, one entry, ever.
 *
 * Deliberately not in `utils/reminder-keys.ts`, and worth saying so because the
 * two look like the same thing. That module owns `reminders.dedupe_key`, whose
 * shape is a fact about the domain — a refill belongs to a prescription, an
 * appointment belongs to a slot — and whose prefix the supersede statement has to
 * match. This one owns `notifications.dedupe_key` and is keyed to the reminder
 * alone, because the question it answers is narrower: has this reminder already
 * been put in the bell? Two modules rather than one, because a change to either
 * shape has different consequences and neither should be edited by somebody
 * reasoning about the other.
 */
export function reminderNotificationKey(reminderId: string): string {
  return `reminder:${reminderId}`;
}

export interface RefreshOptions {
  /** Defaults to {@link DEFAULT_REMINDER_BATCH_LIMIT}. */
  limit?: number;
  /**
   * Injected by tests. Omitted means the configured provider, which is null until
   * A&B sets `SMS_API_URL` and `SMS_API_KEY`.
   */
  provider?: SmsProvider | null;
}

export interface RefreshSummary {
  /** The instant the batch reasoned about, echoed so the run can be identified. */
  now: string;
  /** Reminders selected as pending and due. */
  due: number;
  /** Reminders the provider accepted. Zero while no provider is configured. */
  sent: number;
  /** Reminders nothing was attempted for, each with a reason beside it. */
  notSent: number;
  /** Reminders a provider was reached about and did not complete. */
  failed: number;
  /** Reminders another run had already dealt with, so this one wrote nothing. */
  alreadyDealt: number;
}

type Disposition = 'sent' | 'notSent' | 'failed' | 'alreadyDealt';

function reminderNotification(
  pharmacyId: string,
  reminder: ReminderRow,
  patient: PatientRow | null,
  outcome: SmsOutcome
): NewNotification {
  // Broadcast rather than targeted: a patient reminder is not the property of
  // whoever happened to open the bell first, and `userId: null` is how the
  // repository spells "every staff member sees this".
  return {
    pharmacyId,
    userId: null,
    type: REMINDER_NOTIFICATION_TYPE[reminder.kind],
    title: `${REMINDER_TITLE[reminder.kind]} — ${
      patient === null ? 'patient record missing' : patient.fullName
    }`,
    // The message verbatim. It is the text the patient would have been sent, so the
    // bell shows the same sentence rather than a paraphrase of it — which matters
    // most when nothing was sent, because then a pharmacist reads it aloud instead.
    body: reminder.message,
    relatedType: 'reminder',
    relatedId: reminder.id,
    dedupeKey: reminderNotificationKey(reminder.id),
    // The status and the reason arrive together from one outcome, so there is no
    // path through this function that produces `not_sent` with nothing beside it —
    // which is what `reminders_not_sent_has_reason` requires and what Phase 8's
    // acceptance line means by honest.
    status: outcome.delivered ? 'sent' : outcome.status,
    notSentReason: outcome.delivered ? null : outcome.reason,
    // The same argument in the other direction. A bell entry saying `sent` with no
    // instant beside it is a claim nobody can check, and the provider's own timestamp
    // is the evidence — taken from the provider rather than read locally, because
    // this process handed the message over and cannot know when a handset received it.
    sentAt: outcome.delivered ? outcome.sentAt : null,
  };
}

async function dealWithReminder(
  client: Sql,
  pharmacyId: string,
  reminder: ReminderRow,
  provider: SmsProvider | null
): Promise<Disposition> {
  const patient = await findPatient(client, pharmacyId, reminder.patientId);

  const outcome: SmsOutcome =
    patient === null
      ? { delivered: false, status: 'not_sent', reason: PATIENT_GONE_REASON }
      : await deliverSms({ to: patient.phone, body: reminder.message }, provider);

  const notification = reminderNotification(pharmacyId, reminder, patient, outcome);
  const raised = await raiseNotification(client, notification);

  const updated = await recordReminderOutcome(
    client,
    pharmacyId,
    reminder.id,
    {
      status: notification.status,
      // Supplied explicitly on both branches rather than omitted when sent: a
      // reminder that failed once and succeeded on a retry has to lose the old
      // reason, and `notSentReason: null` with the flag set is how the repository
      // distinguishes "clear it" from "leave it".
      notSentReason: notification.notSentReason,
      // Null when another run already raised this bell entry, in which case that
      // run's outcome carries the id and this one has nothing to add.
      notificationId: raised.notification?.id ?? null,
    },
    ['pending']
  );

  // A null here is the guard refusing, not the row being absent: the reminder was
  // selected as pending moments ago in this same transaction. It means another run
  // dealt with it first, which is the case the guard exists for.
  if (updated === null) return 'alreadyDealt';

  if (notification.status === 'sent') return 'sent';
  return notification.status === 'failed' ? 'failed' : 'notSent';
}

/**
 * Deals with every reminder that is pending and due, once.
 *
 * One transaction, following `scanStockAlerts`. The transaction is not what makes
 * the refresh safe to repeat — the dedupe keys and the guard do that, and they
 * work per row — it is what makes the returned summary a true description of what
 * landed. A run that had dealt with thirty reminders and then failed on the
 * thirty-first would otherwise report thirty and leave the caller believing the
 * batch was finished.
 *
 * `now` is a parameter rather than a clock read, for the reason
 * `listDueReminders` records: every reminder in one run is selected against one
 * instant, so the run can be reasoned about afterwards from the timestamp it was
 * given. `utils/clock.ts` supplies it.
 */
export async function refreshReminders(
  pharmacyId: string,
  now: string,
  options: RefreshOptions = {}
): Promise<RefreshSummary> {
  const limit = options.limit ?? DEFAULT_REMINDER_BATCH_LIMIT;
  const provider = options.provider === undefined ? configuredSmsProvider() : options.provider;

  return withTransaction(async (client) => {
    const due = await listDueReminders(client, pharmacyId, now, limit);
    const counts: Record<Disposition, number> = {
      sent: 0,
      notSent: 0,
      failed: 0,
      alreadyDealt: 0,
    };

    for (const reminder of due) {
      const disposition = await dealWithReminder(client, pharmacyId, reminder, provider);
      counts[disposition] += 1;
    }

    return { now, due: due.length, ...counts };
  });
}

/**
 * The dashboard's reminder list: what is coming up, or what was recently due.
 *
 * A read of persisted rows and not a derivation. The bell reads `notifications`
 * for the same reason, and Phase 8's line about not re-deriving is about both: a
 * reminder re-computed at request time would show a refill as due the moment the
 * rule said so, including after it had been sent, superseded or dealt with, and
 * the dashboard would disagree with its own history.
 */
export async function listReminderPage(
  pharmacyId: string,
  filters: ReminderFilters
): Promise<ReminderRow[]> {
  return listReminders(poolSql, pharmacyId, filters);
}
