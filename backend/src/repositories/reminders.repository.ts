import type { Sql } from '../database/pool';
import { appointmentReminderPrefix, refillReminderKey } from '../utils/reminder-keys';
import type { NotificationStatus, ReminderKind } from '../utils/schema-enums';

/**
 * The reminders table: what the pharmacy intends to tell a patient, and whether
 * it got told.
 *
 * This is not the bell. The bell reads `notifications`, and a reminder reaches it
 * by raising one — which is what makes the dashboard a read rather than a
 * derivation, and what Phase 8's acceptance line means by "the bell reads
 * persisted notifications rather than re-deriving them". A reminder is the
 * intention and the work item; the notification is the thing a member of staff
 * sees. Two tables because they have different lifecycles: a reminder is
 * superseded when an appointment moves, and the notification it already raised
 * stays in the bell as a record that it was raised.
 *
 * ## Why there is no delete
 *
 * Nothing here restricts: `patient_id` cascades and `notification_id` sets null,
 * so a delete would work. It is still absent, because every case that looks like a
 * deletion is a status.
 *
 * A reminder for an appointment that moved is superseded, which is a `not_sent`
 * with a reason beside it — see `supersedeAppointmentReminders`. A reminder the
 * patient asked us to stop sending is the same shape with a different reason. A
 * reminder raised against a prescription that turned out to be wrong is the same
 * again. Removing the row instead would leave a gap where an intention was, and
 * "we meant to tell this patient and then did not, because X" is exactly the
 * sentence a pharmacy needs to be able to answer when somebody asks why a refill
 * was never mentioned.
 *
 * The one case where rows should genuinely go is a patient being erased, and the
 * schema does it: `patient_id ... on delete cascade`. The application has nothing
 * to add to that, and a delete function here would be a second way to remove
 * reminders with no reason recorded beside either.
 *
 * ## Deduplication is the database's, not the application's
 *
 * `unique (pharmacy_id, dedupe_key)` plus `on conflict do nothing returning` is the
 * whole mechanism, following `raiseNotification`. Deciding in the application
 * instead — select, then insert if absent — is a race with a window exactly as
 * wide as the two round trips between the read and the write, and the failure mode
 * is a duplicate reminder: the patient gets the same text message twice, which is
 * the thing the unique index exists to prevent and the thing Phase 8's acceptance
 * line asks to see proven. Section 18 executes it against a real server by
 * refreshing twice and requiring the second refresh to raise nothing.
 *
 * The key's shape is not this module's business — `utils/reminder-keys.ts` owns
 * it, because the supersede statement below has to match a prefix of the same key
 * and two spellings of one format would drift silently.
 *
 * ## Why an unsent reminder always carries a reason
 *
 * `reminders_not_sent_has_reason`, added by migration 0005, refuses a `not_sent`
 * or `failed` row with no `not_sent_reason`. That is Phase 8's other acceptance
 * line — "every reminder that has not been sent is labelled as not sent and why" —
 * enforced by the schema rather than by a convention in the service. It matters
 * most in `supersedeAppointmentReminders`, where `status = 'not_sent'` is written
 * as a literal: pass a null reason and the server refuses the update with 23514
 * rather than writing a row that says "not sent" and nothing else.
 */

const REMINDER_COLUMNS = `id, pharmacy_id, patient_id, kind, due_at, message,
  status, not_sent_reason, notification_id, dedupe_key, created_at, updated_at`;

/**
 * The list's filter rule, spelled once and shared by both orderings.
 *
 * One statement per ordering with nullable parameters rather than a `where`
 * spliced together per combination, for the reason `notifications.repository.ts`
 * records: the placeholder count stops depending on the caller's input, so the
 * harness needs one PREPARE per ordering instead of one per shape.
 *
 * Both bounds are on `due_at` and not `created_at`. When a reminder was written is
 * bookkeeping; when it is due is the fact a dashboard sorts by, and a list ordered
 * by one and filtered by the other is a list whose pages do not line up with its
 * own filter.
 *
 * `to` is widened to the whole day, as in the other list statements: `due_at` is a
 * `timestamptz`, so `$6::date` is midnight at the *start* of the day and a closing
 * bound of `<=` would drop every reminder due on the last day asked for.
 */
const FILTERS = `($2::uuid is null or patient_id = $2::uuid)
        and ($3::reminder_kind[] is null or kind = any($3::reminder_kind[]))
        and ($4::notification_status[] is null or status = any($4::notification_status[]))
        and ($5::date is null or due_at >= $5::date)
        and ($6::date is null or due_at < $6::date + interval '1 day')`;

/** Soonest first: what is coming up, which is how a dashboard reads a reminder list. */
const ORDER_UPCOMING = 'order by due_at asc, id asc';

/**
 * Latest first: what was most recently due, which is how a patient's history reads.
 *
 * Two whole orderings rather than one reversed, because with `limit` and `offset`
 * reversing a page is not reversing an ordering.
 */
const ORDER_RECENT = 'order by due_at desc, id desc';

export interface ReminderRow {
  id: string;
  pharmacyId: string;
  /** Not null in the schema: a reminder is always for somebody. */
  patientId: string;
  kind: ReminderKind;
  dueAt: string;
  /** The text the patient would be sent. Not null, so it is written when the reminder is. */
  message: string;
  status: NotificationStatus;
  /**
   * Why nothing was sent. Guaranteed present whenever `status` is `not_sent` or
   * `failed`, by `reminders_not_sent_has_reason` rather than by this module — so a
   * caller reading a row does not have to defend against an unexplained one.
   */
  notSentReason: string | null;
  /**
   * The notification this reminder raised, once it raised one. Null while pending,
   * and set null by the foreign key if that notification is ever removed, so a
   * reminder outlives the bell entry it produced.
   */
  notificationId: string | null;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewReminder {
  pharmacyId: string;
  patientId: string;
  kind: ReminderKind;
  /** ISO 8601. When the reminder becomes due, not when it was written. */
  dueAt: string;
  message: string;
  /**
   * Built by `utils/reminder-keys.ts`. Taken as an input rather than derived here,
   * because what makes two reminders "the same" is a decision about the domain —
   * a refill belongs to a prescription, an appointment belongs to a slot — and this
   * module's job is to make the decision enforceable rather than to make it.
   */
  dedupeKey: string;
}

export interface ScheduleResult {
  /** True when this call created the row; false when one already held the key. */
  scheduled: boolean;
  /** The new row, or null when a reminder with this key already existed. */
  reminder: ReminderRow | null;
}

/**
 * What the scheduler writes back after it has dealt with a reminder.
 *
 * `status` is required and written directly rather than coalesced: an outcome
 * without a status is not an outcome. `notSentReason` is flagged, so a retry that
 * succeeds can clear the reason a previous attempt left behind — a `sent` reminder
 * still saying "no SMS provider is configured" beside it would be a contradiction
 * the constraint permits and nobody wants to read. `notificationId` is coalesced,
 * because it is set once when the reminder raises its notification and there is no
 * operation that should un-set it.
 */
export interface ReminderOutcome {
  status: NotificationStatus;
  /** Required beside `not_sent` and `failed` by the schema, not by this type. */
  notSentReason?: string | null;
  notificationId?: string | null;
}

export interface ReminderFilters {
  /** One patient's reminders. Omitted or null means the whole pharmacy. */
  patientId?: string | null;
  /**
   * Restrict to these kinds. Omitted or empty means both, and empty is folded into
   * "both" rather than sent as an empty array: `kind = any('{}')` is valid SQL
   * matching no row, so a dashboard asked for nothing would show nothing and read
   * as a pharmacy with no reminders due.
   */
  kinds?: readonly ReminderKind[];
  /** As `kinds`, and folded for the same reason. */
  statuses?: readonly NotificationStatus[];
  /** `YYYY-MM-DD`, inclusive, on `due_at`. */
  from?: string | null;
  /** `YYYY-MM-DD`, inclusive of the whole day, on `due_at`. */
  to?: string | null;
  /** `'upcoming'` (the default) for a dashboard, `'recent'` for a patient's history. */
  order?: 'upcoming' | 'recent';
  limit: number;
  offset: number;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapReminder(row: Record<string, unknown>): ReminderRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    patientId: row.patient_id as string,
    kind: row.kind as ReminderKind,
    dueAt: (row.due_at as Date).toISOString(),
    message: row.message as string,
    status: row.status as NotificationStatus,
    notSentReason: textOrNull(row.not_sent_reason),
    notificationId: textOrNull(row.notification_id),
    dedupeKey: row.dedupe_key as string,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Schedules a reminder unless one already holds its dedupe key.
 *
 * The insert names six columns, and three more are deliberately absent:
 *
 *   - `status`, so a new reminder is `pending` because the *column* says so. A
 *     parameter for it would be a way to write a reminder that claims to have been
 *     sent when nothing was attempted, which is the dishonest state migration 0005
 *     exists to make impossible.
 *   - `not_sent_reason`, because a reminder that has not been reached yet has
 *     nothing to report. The reason arrives with the outcome.
 *   - `notification_id`, because the notification does not exist yet. Setting it
 *     here would need a notification id from the caller, and a caller holding one
 *     would be able to attach a reminder to a bell entry about something else.
 *
 * Section 18 proves all three defaults against a real server rather than assuming
 * them from `init.sql`.
 */
export async function scheduleReminder(
  sql: Sql,
  input: NewReminder
): Promise<ScheduleResult> {
  const result = await sql.query(
    `insert into reminders
       (pharmacy_id, patient_id, kind, due_at, message, dedupe_key)
     values ($1, $2, $3::reminder_kind, $4::timestamptz, $5, $6)
     on conflict (pharmacy_id, dedupe_key) do nothing
     returning ${REMINDER_COLUMNS}`,
    [
      input.pharmacyId,
      input.patientId,
      input.kind,
      input.dueAt,
      input.message,
      input.dedupeKey,
    ]
  );
  const inserted = result.rows[0];
  // `rowCount === 0` and no returned row are the same fact seen twice: the unique
  // index already held this key. Not an error, and not worth a second query to
  // fetch the existing row — a refresh reports whether anything changed, and the
  // caller that needs the row already has it from the refresh that created it.
  return inserted === undefined
    ? { scheduled: false, reminder: null }
    : { scheduled: true, reminder: mapReminder(inserted) };
}

/**
 * One reminder by id, or null.
 *
 * This is what makes a null from `recordReminderOutcome` mean something: call it
 * inside the same transaction, as the other guarded updates require, and a null
 * return is the guard refusing rather than the row being absent. For a reminder
 * the two are very different sentences — one is a stale row in a scheduler's
 * batch and the other is a reminder that has already been dealt with, which is the
 * case that stops a patient getting the same message twice.
 */
export async function findReminder(
  sql: Sql,
  pharmacyId: string,
  reminderId: string
): Promise<ReminderRow | null> {
  const result = await sql.query(
    `select ${REMINDER_COLUMNS} from reminders
      where pharmacy_id = $1 and id = $2`,
    [pharmacyId, reminderId]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapReminder(first);
}

/**
 * The scheduler's queue: everything pending and due, soonest first.
 *
 * `status = 'pending'` is a literal and not a parameter, which is unusual for this
 * codebase and deliberate. `reminders_pharmacy_due_idx` is a partial index on
 * `(pharmacy_id, due_at) where status = 'pending'`, and the planner will only
 * consider it when the query's own predicate implies the index's. A parameter
 * would leave the value unknown at plan time, so the index would not be used and
 * the queue would be a sequential scan of every reminder the pharmacy has ever
 * written — growing forever, scanned on every scheduler tick, to find the handful
 * that are due.
 *
 * `due_at <= $2` rather than `<`: a reminder due at exactly the moment the
 * scheduler ran is due, and an exclusive bound would push it to the next tick and
 * then the one after that for as long as the clock happened to land on it. This is
 * also not the day-widening the list uses, because `now` is a `timestamptz` from
 * the caller rather than a `date` — there is no midnight to widen from.
 *
 * `now` is a parameter rather than the SQL function, so every reminder in one
 * scheduler run is selected against one instant and the run can be reasoned about
 * afterwards from the timestamp it was given.
 */
export async function listDueReminders(
  sql: Sql,
  pharmacyId: string,
  now: string,
  limit: number
): Promise<ReminderRow[]> {
  const result = await sql.query(
    `select ${REMINDER_COLUMNS} from reminders
      where pharmacy_id = $1
        and status = 'pending'
        and due_at <= $2::timestamptz
      order by due_at asc, id asc
      limit $3`,
    [pharmacyId, now, limit]
  );
  return result.rows.map(mapReminder);
}

export async function listReminders(
  sql: Sql,
  pharmacyId: string,
  filters: ReminderFilters
): Promise<ReminderRow[]> {
  const kinds =
    filters.kinds !== undefined && filters.kinds.length > 0 ? [...filters.kinds] : null;
  const statuses =
    filters.statuses !== undefined && filters.statuses.length > 0
      ? [...filters.statuses]
      : null;
  const order = filters.order === 'recent' ? ORDER_RECENT : ORDER_UPCOMING;

  const result = await sql.query(
    `select ${REMINDER_COLUMNS} from reminders
      where pharmacy_id = $1
        and ${FILTERS}
      ${order}
      limit $7 offset $8`,
    [
      pharmacyId,
      filters.patientId ?? null,
      kinds,
      statuses,
      filters.from ?? null,
      filters.to ?? null,
      filters.limit,
      filters.offset,
    ]
  );
  return result.rows.map(mapReminder);
}

/**
 * Writes what the scheduler did with a reminder, or writes nothing and returns
 * null if the guard refused.
 *
 * `allowedFrom` is what stops a reminder being dealt with twice. Two scheduler
 * runs overlapping — one slow tick, a restart, a cron that fired twice — both
 * select the same pending rows, and without the guard both would write an outcome
 * and both would raise a notification. With it, the second run's update matches no
 * row: the reminder is no longer `pending`. That is a database-level answer to a
 * concurrency question, and it is why the guard is a parameter the caller chooses
 * rather than a rule written into the statement — the scheduler passes
 * `['pending']`, and a future backfill correcting a reason passes whatever states
 * it is actually entitled to correct.
 *
 * Seven parameters in one fixed shape rather than a `set` list assembled from
 * whichever optionals arrived, for the reason the other preserving updates record:
 * a dynamic builder turns one statement into one per combination, and the
 * combinations no test exercised would be statements nobody ever parsed against
 * the real schema.
 */
export async function recordReminderOutcome(
  sql: Sql,
  pharmacyId: string,
  reminderId: string,
  outcome: ReminderOutcome,
  allowedFrom: readonly NotificationStatus[]
): Promise<ReminderRow | null> {
  const result = await sql.query(
    `update reminders
        set status = $3::notification_status,
            not_sent_reason = case when $4::boolean then $5::text
                                   else not_sent_reason end,
            notification_id = coalesce($6::uuid, notification_id)
      where pharmacy_id = $1
        and id = $2
        and status = any($7::notification_status[])
      returning ${REMINDER_COLUMNS}`,
    [
      pharmacyId,
      reminderId,
      outcome.status,
      outcome.notSentReason !== undefined,
      outcome.notSentReason ?? null,
      outcome.notificationId ?? null,
      [...allowedFrom],
    ]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapReminder(first);
}

/**
 * Supersedes every pending appointment reminder for one consultation except the
 * key the caller says is still current, and says how many that was.
 *
 * The appointment moved, so the reminders raised for the old slot have to stop.
 * They cannot be found by a foreign key — `reminders` has no `consultation_id` and
 * points at a consultation only through text in `dedupe_key` — so this matches the
 * prefix that `utils/reminder-keys.ts` builds, with the wildcard written into the
 * statement and the prefix bound as a parameter. Section 18 executes it against a
 * real server: two slots for one consultation, the older superseded and the newer
 * kept.
 *
 * `keepDedupeKey` is required rather than optional, and it is what makes the
 * operation safe to run before raising the new reminder. Without it, editing a
 * consultation whose slot did not change would supersede the reminder for the slot
 * that is still current and then re-raise it — a fresh `pending` row where a
 * `sent` one was, and a patient texted twice about one appointment.
 *
 * Three predicates narrow it further, and each is there for a reason:
 *
 *   - `kind = 'appointment'` because a refill reminder's key never starts with
 *     `appointment:` and matching one would be a bug nobody could see.
 *   - `status = 'pending'` because a reminder already dealt with is a record of
 *     what happened and is not this function's to rewrite. It also means a
 *     superseded reminder has necessarily never raised a notification —
 *     `recordReminderOutcome` writes the status and the notification id in one
 *     statement — so there is no bell entry left describing a slot that no longer
 *     exists. That is a consequence worth stating rather than a coincidence.
 *   - `dedupe_key <> $2` is `keepDedupeKey`, above.
 *
 * `status = 'not_sent'` is a literal. Superseding has exactly one meaning, and a
 * parameter would be a way to write `'sent'` for a message nobody sent. The reason
 * is a parameter and the schema requires it: pass null and
 * `reminders_not_sent_has_reason` refuses the whole update with 23514, which is
 * the acceptance line enforcing itself.
 *
 * Only `id` comes back, following `markAllRead`: counting rows does not need
 * twelve columns each.
 */
export async function supersedeAppointmentReminders(
  sql: Sql,
  pharmacyId: string,
  consultationId: string,
  keepDedupeKey: string,
  reason: string
): Promise<number> {
  const result = await sql.query(
    `update reminders
        set status = 'not_sent',
            not_sent_reason = $4::text
      where pharmacy_id = $1
        and kind = 'appointment'
        and status = 'pending'
        and dedupe_key like ($3::text || '%')
        and dedupe_key <> $2::text
      returning id`,
    [pharmacyId, keepDedupeKey, appointmentReminderPrefix(consultationId), reason]
  );
  return result.rows.length;
}

/**
 * Stops the collection reminder for one prescription, and says whether there was
 * one to stop.
 *
 * The mirror of `supersedeAppointmentReminders` with three differences, each
 * following from the key's shape rather than chosen separately:
 *
 *   - It matches the whole key with `=` and not a prefix with `like`. A refill is
 *     keyed to the prescription alone, so there is exactly one reminder per
 *     prescription and nothing to narrow down. No wildcard reaches the statement,
 *     which means no `likePattern` escaping question arises either.
 *   - It takes no `keepDedupeKey`. The appointment version needs one because it
 *     runs *before* raising the replacement and must not cancel it; nothing is
 *     raised after this, so there is no key to protect.
 *   - It returns a boolean rather than a count. At most one row can match, so the
 *     count would only ever be 0 or 1 and a number that cannot exceed one is a
 *     boolean wearing a more general type.
 *
 * ## Why dispensing has to call this
 *
 * Without it, a prescription approved on Monday and collected on Monday still
 * sends its reminder on Tuesday: the row is `pending`, its `due_at` arrives, and
 * `reminders_pharmacy_due_idx` hands it to the scheduler. The patient receives a
 * text telling them to come in for medicine they are holding — which is the exact
 * failure `utils/reminder-keys.ts` names as the reason a refill key carries no
 * month in it. Keying the reminder correctly stops a *second* one being raised;
 * only superseding stops the *first* one firing.
 *
 * The same applies to a rejection after an approval, for the same reason in the
 * other direction: the pharmacist has decided not to supply, and a reminder to
 * collect is now a promise the pharmacy is not keeping.
 *
 * `kind = 'refill'` and `status = 'pending'` are literals, for the reasons the
 * appointment version records: superseding has one meaning, and a reminder already
 * dealt with is a record of what happened rather than something to rewrite. Writing
 * `status = 'pending'` as a literal also matches the partial predicate
 * `reminders_pharmacy_due_idx` is built on, so the planner can use it.
 */
export async function supersedeRefillReminder(
  sql: Sql,
  pharmacyId: string,
  prescriptionId: string,
  reason: string
): Promise<boolean> {
  const result = await sql.query(
    `update reminders
        set status = 'not_sent',
            not_sent_reason = $3::text
      where pharmacy_id = $1
        and kind = 'refill'
        and status = 'pending'
        and dedupe_key = $2::text
      returning id`,
    [pharmacyId, refillReminderKey(prescriptionId), reason]
  );
  return result.rows.length > 0;
}
