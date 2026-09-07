import type { Sql } from '../database/pool';
import type { ConsultationStatus, ConsultationType } from '../utils/schema-enums';

/**
 * The consultations table: bookings, the diary, and the transition between them.
 *
 * ## Why `status` is not an input to a booking
 *
 * The insert names eight columns and `status` is not one of them, so a new
 * consultation takes the column default. That is a structural guarantee rather
 * than a convention: there is no parameter a caller could create a `completed`
 * consultation through, so a booking cannot arrive already finished. Getting a
 * consultation to any other state goes through `updateConsultation`, which is
 * where the rule about which states may follow which lives — and a rule in one
 * guarded statement is a rule that can be tested, where a rule spread across two
 * writers is a rule somebody will eventually get wrong in the one nobody reads.
 *
 * The default itself is not assumed. Section 16 of the harness books a
 * consultation without naming a status and requires `'scheduled'` back, so the
 * reliance is proven against the real schema rather than against a reading of
 * `init.sql`.
 *
 * ## Why there is no delete
 *
 * Two reasons, and the second is the one that matters.
 *
 * `conducted_by uuid references users (id)` carries no `on delete` clause, so it
 * restricts: a consultation cannot be removed by removing the pharmacist who held
 * it. That is the same asymmetry `patients.repository.ts` records, in the other
 * direction.
 *
 * The stronger reason is that `reminders` has no `consultation_id`. It points at
 * a consultation only through `dedupe_key`, which is text the engagement service
 * builds as `appointment:<consultation id>:<scheduled time>`. A deleted
 * consultation would therefore leave a live reminder with nothing to remind
 * about, and it would fire: the row is still `pending`, still due, still in the
 * index that `reminders_pharmacy_due_idx` keeps for exactly that query. Cancelling
 * is the operation that removes an appointment, because cancelling can take the
 * reminder with it. Deleting cannot, and so it is not offered.
 *
 * ## Video is a link-out
 *
 * `video_url` holds an address somebody else is hosting. There is no media
 * infrastructure here and there should not be: a pharmacy booking a handful of
 * consultations a month does not benefit from a WebRTC server it has to keep
 * patched. The column is validated at the boundary rather than here, and the
 * validation has to refuse a `javascript:` URL as well as a malformed one,
 * because this value ends up in an `href` and a stored scheme is a stored script.
 */

const CONSULTATION_COLUMNS = `id, pharmacy_id, patient_id, conducted_by, type,
  status, scheduled_at, duration_minutes, video_url, notes, created_at, updated_at`;

/**
 * The diary's filter rule, spelled once and shared by both orderings.
 *
 * One statement per ordering with nullable parameters rather than a `where`
 * spliced together per combination, for the reason `notifications.repository.ts`
 * records: the placeholder count stops depending on the caller's input, so the
 * harness needs two PREPAREs instead of one per shape, and a combination no test
 * happened to exercise is still a statement somebody parsed against the real
 * schema.
 *
 * `to` is widened to the whole day, as in `screenings.repository.ts`: `scheduled_at`
 * is a `timestamptz`, so `$6::date` is midnight at the *start* of the day and a
 * closing bound of `<=` would drop every appointment on the last day asked for.
 */
const FILTERS = `($2::uuid is null or patient_id = $2::uuid)
        and ($3::consultation_status[] is null or status = any($3::consultation_status[]))
        and ($4::uuid is null or conducted_by = $4::uuid)
        and ($5::date is null or scheduled_at >= $5::date)
        and ($6::date is null or scheduled_at < $6::date + interval '1 day')`;

/**
 * Soonest first: what is coming up, which is the order a diary is read in.
 *
 * `id asc` is the tie-break rather than decoration. Two consultations booked for
 * the same instant is not exotic — it is what a double-booking looks like — and
 * without a tie-break their relative order is whatever the planner felt like, so
 * the two would swap places between loads of the same page.
 */
const ORDER_UPCOMING = 'order by scheduled_at asc, id asc';

/**
 * Latest first: what has already happened, which is the order a history is read
 * in. The same tie-break, in the same direction relative to its ordering, so two
 * consultations at one instant stay in one order in both views.
 */
const ORDER_RECENT = 'order by scheduled_at desc, id desc';

export interface ConsultationRow {
  id: string;
  pharmacyId: string;
  /** Never null: the column is `not null`, because a consultation is with somebody. */
  patientId: string;
  /**
   * Null until somebody is assigned, and clearable again — a pharmacist calling
   * in sick leaves the appointment booked and unassigned rather than cancelled.
   */
  conductedBy: string | null;
  type: ConsultationType;
  status: ConsultationStatus;
  scheduledAt: string;
  /**
   * Null means no length was given, which is not the same as zero minutes. The
   * schema says the same with `check (duration_minutes is null or
   * duration_minutes >= 0)`: a length can be absent, and it cannot be negative.
   */
  durationMinutes: number | null;
  /**
   * The link-out, and only ever set for a `video` consultation by the service —
   * the column itself does not say so, because a chat or a phone consultation has
   * no reason to carry one and a constraint on "only this type may use this
   * column" is a rule the schema would have to enforce with a trigger to get
   * right.
   */
  videoUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewConsultation {
  pharmacyId: string;
  patientId: string;
  conductedBy?: string | null;
  type: ConsultationType;
  /** An ISO instant. No `status`: see the top of this file. */
  scheduledAt: string;
  durationMinutes?: number | null;
  videoUrl?: string | null;
  notes?: string | null;
}

/**
 * What may be changed about a consultation, and the states it may be changed from.
 *
 * Every field is optional and `undefined` means "not supplied" while `null` means
 * "clear it", which is the distinction `coalesce` cannot make and the reason four
 * of these columns are written with a `case` and a boolean flag instead. A
 * video consultation moved to `in_person` has to be able to lose its link; a
 * `coalesce` would keep it, and the record would be handing out an address for a
 * meeting that is now happening across a counter.
 */
export interface ConsultationPatch {
  type?: ConsultationType;
  status?: ConsultationStatus;
  scheduledAt?: string;
  durationMinutes?: number | null;
  conductedBy?: string | null;
  videoUrl?: string | null;
  notes?: string | null;
  /**
   * The statuses the consultation may be in for this patch to apply.
   *
   * A parameter rather than a rule written into the statement, following
   * `updateSalePaymentStatus`: rescheduling is only sound while a consultation is
   * still `scheduled`, but marking one `completed` is only sound from `scheduled`
   * too, and marking one `no_show` may be sound from `scheduled` alone while a
   * rebooking rule wants something else. Those are decisions for the service,
   * which is where the sentence explaining a refusal is written.
   */
  allowedFrom: readonly ConsultationStatus[];
}

export interface ConsultationFilters {
  /** One patient's consultations. Omitted or null means the whole pharmacy. */
  patientId?: string | null;
  /**
   * Restrict to these statuses. Omitted or empty means every status, and empty is
   * folded into "every status" here rather than sent as an empty array:
   * `status = any('{}')` is valid SQL matching no row, so a diary asked for
   * nothing would show nothing and read as a pharmacy with no appointments.
   */
  statuses?: readonly ConsultationStatus[];
  /** One pharmacist's diary. Omitted or null means everybody's. */
  conductedBy?: string | null;
  /** `YYYY-MM-DD`, inclusive. */
  from?: string | null;
  /** `YYYY-MM-DD`, inclusive of the whole day. */
  to?: string | null;
  /**
   * `'upcoming'` (the default) is soonest first and `'recent'` is latest first.
   *
   * Both are whole orderings rather than one ordering reversed, because reversing
   * a page is not reversing an ordering: with `limit` and `offset` it returns the
   * same rows in the other sequence, which for a diary is the wrong set entirely.
   */
  order?: 'upcoming' | 'recent';
  limit: number;
  offset: number;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * `duration_minutes` is an `integer`, which node-pg parses to a JS number, so a
 * `typeof` check is complete here.
 *
 * That is not true of every numeric column and the difference is worth recording
 * next to the code that depends on it: `numeric` arrives as decimal *text*, which
 * is why `screenings.repository.ts` converts through `toNumberOrNull` rather than
 * checking a type. Applying this mapper to a `numeric` would silently null every
 * reading; applying that one here would work and hide the distinction.
 */
function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mapConsultation(row: Record<string, unknown>): ConsultationRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    patientId: row.patient_id as string,
    conductedBy: textOrNull(row.conducted_by),
    type: row.type as ConsultationType,
    status: row.status as ConsultationStatus,
    scheduledAt: (row.scheduled_at as Date).toISOString(),
    durationMinutes: integerOrNull(row.duration_minutes),
    videoUrl: textOrNull(row.video_url),
    notes: textOrNull(row.notes),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function createConsultation(
  sql: Sql,
  input: NewConsultation
): Promise<ConsultationRow> {
  const result = await sql.query(
    `insert into consultations
       (pharmacy_id, patient_id, conducted_by, type, scheduled_at, duration_minutes,
        video_url, notes)
     values ($1, $2, $3, $4::consultation_type, $5::timestamptz, $6::integer, $7, $8)
     returning ${CONSULTATION_COLUMNS}`,
    [
      input.pharmacyId,
      input.patientId,
      input.conductedBy ?? null,
      input.type,
      input.scheduledAt,
      input.durationMinutes ?? null,
      input.videoUrl ?? null,
      input.notes ?? null,
    ]
  );
  const inserted = result.rows[0];
  if (inserted === undefined) {
    // INSERT ... RETURNING always yields the row it inserted. Nothing on this
    // table can swallow it: there is no unique index and no ON CONFLICT.
    throw new Error('insert into consultations returned no row');
  }
  return mapConsultation(inserted);
}

/**
 * One consultation by id, or null.
 *
 * This is what makes a null from `updateConsultation` mean something. Call it
 * inside the same transaction as the update, as `sales.service.ts` does before
 * `updateSalePaymentStatus`. Without that, a null return from the guarded update
 * is ambiguous between "no such consultation" and "not in a state that allows
 * this", and the two are different sentences: one is a stale link in somebody's
 * browser and the other is an appointment that has already happened.
 */
export async function findConsultation(
  sql: Sql,
  pharmacyId: string,
  consultationId: string
): Promise<ConsultationRow | null> {
  const result = await sql.query(
    `select ${CONSULTATION_COLUMNS} from consultations
      where pharmacy_id = $1 and id = $2`,
    [pharmacyId, consultationId]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapConsultation(first);
}

/**
 * The diary, and a patient's consultation history.
 *
 * The bounds are `date` rather than `timestamptz`, which is a decision about what
 * a diary is for rather than a simplification. "From today" includes an appointment
 * at nine this morning when it is now three in the afternoon, and that is correct:
 * it is still on today's list because it still needs a status, and hiding it would
 * be how a consultation nobody marked `no_show` quietly stops being anybody's
 * problem. A view that genuinely wants "from this instant" can filter the page it
 * gets, and only that page, because it knows the ordering.
 *
 * There is deliberately no `countConsultations` beside this, unlike
 * `patients.repository.ts`. The patient book grows without bound and its list is
 * paginated with a total; a diary is bounded by the slots a pharmacy has, and both
 * of its views are "what is coming up" and "the last few", neither of which shows
 * a total. A second query per load would buy a number nobody reads. If a paginated
 * consultation list is ever added, `countPatients` is the shape to copy.
 */
export async function listConsultations(
  sql: Sql,
  pharmacyId: string,
  filters: ConsultationFilters
): Promise<ConsultationRow[]> {
  const statuses =
    filters.statuses !== undefined && filters.statuses.length > 0
      ? [...filters.statuses]
      : null;
  const order = filters.order === 'recent' ? ORDER_RECENT : ORDER_UPCOMING;

  const result = await sql.query(
    `select ${CONSULTATION_COLUMNS} from consultations
      where pharmacy_id = $1
        and ${FILTERS}
      ${order}
      limit $7 offset $8`,
    [
      pharmacyId,
      filters.patientId ?? null,
      statuses,
      filters.conductedBy ?? null,
      filters.from ?? null,
      filters.to ?? null,
      filters.limit,
      filters.offset,
    ]
  );
  return result.rows.map(mapConsultation);
}

/**
 * Applies a patch, or applies nothing and returns null if the guard refused.
 *
 * Fourteen parameters in one fixed shape rather than a `set` list assembled from
 * whichever optionals arrived, for the reason `patients.repository.ts` records: a
 * read-modify-write full-row patch loses whatever a colleague changed in between,
 * and a dynamic builder turns one statement into one per combination of supplied
 * fields — 128 of them here, most of which no test would ever exercise.
 *
 * `not null` columns are written with `coalesce`, because there is nothing to
 * clear; nullable ones with a `case` on a supplied-flag, because `coalesce` cannot
 * tell "not supplied" from "set to null".
 *
 * The guard reads the *pre-update* status, so passing `status` in the patch and
 * `allowedFrom` beside it is a transition rather than a contradiction: the row has
 * to be in one of the allowed states to leave it.
 */
export async function updateConsultation(
  sql: Sql,
  pharmacyId: string,
  consultationId: string,
  patch: ConsultationPatch
): Promise<ConsultationRow | null> {
  const result = await sql.query(
    `update consultations
        set type = coalesce($3::consultation_type, type),
            status = coalesce($4::consultation_status, status),
            scheduled_at = coalesce($5::timestamptz, scheduled_at),
            duration_minutes = case when $6::boolean then $7::integer
                                    else duration_minutes end,
            conducted_by = case when $8::boolean then $9::uuid
                                else conducted_by end,
            video_url = case when $10::boolean then $11::text
                             else video_url end,
            notes = case when $12::boolean then $13::text else notes end
      where pharmacy_id = $1
        and id = $2
        and status = any($14::consultation_status[])
      returning ${CONSULTATION_COLUMNS}`,
    [
      pharmacyId,
      consultationId,
      patch.type ?? null,
      patch.status ?? null,
      patch.scheduledAt ?? null,
      patch.durationMinutes !== undefined,
      patch.durationMinutes ?? null,
      patch.conductedBy !== undefined,
      patch.conductedBy ?? null,
      patch.videoUrl !== undefined,
      patch.videoUrl ?? null,
      patch.notes !== undefined,
      patch.notes ?? null,
      [...patch.allowedFrom],
    ]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapConsultation(first);
}
