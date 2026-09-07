import { poolSql, withTransaction } from '../database/pool';
import {
  createConsultation,
  findConsultation,
  listConsultations,
  updateConsultation,
  type ConsultationFilters,
  type ConsultationRow,
} from '../repositories/consultations.repository';
import type { ConsultationStatus } from '../utils/schema-enums';
import { findPatient } from '../repositories/patients.repository';
import { findUserById } from '../repositories/users.repository';
import {
  scheduleReminder,
  supersedeAppointmentReminders,
} from '../repositories/reminders.repository';
import type { Actor } from './inventory.service';
import { nowIso } from '../utils/clock';
import { HttpError, notFound } from '../utils/http';
import { can } from '../utils/permissions';
import { appointmentReminderKey } from '../utils/reminder-keys';
import { PHARMACY_NAME, SMS_BODY_MAX_LENGTH } from './sms';

/**
 * Booking a consultation, moving it, and ending it — with the appointment
 * reminder moving and ending alongside it.
 *
 * ## Why the reminder is this module's business
 *
 * `reminders` has no `consultation_id`. It points at a consultation only through
 * `dedupe_key`, which is why a reschedule has to supersede by prefix and why the
 * prefix and the key are both built by `utils/reminder-keys.ts`. That coupling is
 * invisible from the repository: `updateConsultation` changes a row and knows
 * nothing about reminders. Left to a caller to remember, the day it is forgotten
 * is the day a patient is texted about a slot that no longer exists — a reminder
 * that is still `pending`, still due, still in the index that exists for exactly
 * that query, and nothing anywhere errors.
 *
 * So every write to a consultation goes through here, and the rule is one
 * sentence: **a reminder is only meaningful while the appointment is still to
 * come.** Moving the appointment moves the reminder. Ending the appointment —
 * completed, cancelled or missed — supersedes whatever is still pending for it,
 * because a reminder that fires after the fact tells a patient to attend
 * something that already happened.
 *
 * ## Video is a link-out, and the link is checked
 *
 * There is no media infrastructure here and there should not be. `videoUrl` holds
 * an address somebody else hosts, and it ends up in an `href` on the consultation
 * page — so a stored scheme is a stored script. `videoUrlFrom` refuses everything
 * that is not `https:`, which rules out `javascript:` and `data:` by not being
 * the one thing allowed rather than by matching a blocklist.
 */

/**
 * How far ahead of the appointment the reminder becomes due.
 *
 * A day, which is the lead that leaves time to change the plan: a reminder that
 * arrives an hour ahead tells a patient about an appointment they can no longer
 * rearrange, and one that arrives a week ahead is forgotten by the time it
 * matters.
 */
export const APPOINTMENT_REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Ghana's zone by name rather than an offset.
 *
 * `Africa/Accra` is UTC+0 with no daylight saving, so an ISO instant's UTC
 * rendering would happen to be the right local time — but that is a fact about
 * the current offset, and a message that says "09:00" is a claim about a clock on
 * a wall in Accra. Naming the zone says which clock, and keeps saying it if the
 * answer ever changes.
 */
export const APPOINTMENT_TIME_ZONE = 'Africa/Accra';

/**
 * The `keepDedupeKey` that keeps nothing.
 *
 * `supersedeAppointmentReminders` excludes one key so a reschedule can raise the
 * new reminder without immediately cancelling it. Ending an appointment wants no
 * such exception, and the empty string is the value that expresses it: every key
 * this system writes begins with `appointment:` or `refill:`, so no reminder holds
 * `''` and `dedupe_key <> ''` excludes nothing.
 *
 * A constant rather than an inline `''` because `''` at a call site reads like a
 * mistake, and this is the one place where it is the intended answer.
 */
export const SUPERSEDE_ALL_KEYS = '';

/** The states a consultation may be moved out of, for any transition. */
const MOVABLE_FROM: readonly ConsultationStatus[] = ['scheduled'];

/** Why a superseded reminder was not sent, by the transition that superseded it. */
const ENDED_REASON: Record<Exclude<ConsultationStatus, 'scheduled'>, string> = {
  completed: 'The appointment has already taken place.',
  cancelled: 'The appointment was cancelled, so there is nothing to remind about.',
  no_show: 'The appointment was not attended, so there is nothing to remind about.',
};

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: APPOINTMENT_TIME_ZONE,
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: APPOINTMENT_TIME_ZONE,
});

/** One consultation, as the API returns it. Exported for the api-types mirror. */
export type ConsultationView = ConsultationRow;

/** What the booking form posts. */
export interface ConsultationInput {
  patientId: string;
  type: ConsultationInputType;
  scheduledAt: string;
  conductedBy?: string | null;
  durationMinutes?: number | null;
  videoUrl?: string | null;
  notes?: string | null;
}

export type ConsultationInputType = ConsultationRow['type'];

/** What a reschedule posts. The patient cannot be changed: that is a new booking. */
export interface RescheduleInput {
  scheduledAt: string;
  type?: ConsultationInputType;
  conductedBy?: string | null;
  durationMinutes?: number | null;
  videoUrl?: string | null;
  notes?: string | null;
}

export interface ConsultationPage {
  consultations: ConsultationView[];
}

/**
 * The link-out, or null.
 *
 * `https:` alone, by allowlist. A blocklist of `javascript:` and `data:` would be
 * a list of the schemes somebody thought of, and `new URL` parses schemes nobody
 * would think to block. Refusing everything that is not the one scheme a video
 * call is actually hosted on leaves nothing to remember.
 *
 * Plain `http:` is refused too. It is not a script risk, it is a privacy one: the
 * page is served over TLS, so an `http` link is either blocked as mixed content or
 * followed to a meeting address sent in the clear.
 */
export function videoUrlFrom(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new HttpError(400, 'Enter the meeting link as a full web address, starting https://', {
      code: 'validation_failed',
      details: [{ field: 'videoUrl', message: 'That is not a web address' }],
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new HttpError(400, 'The meeting link must start with https://', {
      code: 'validation_failed',
      details: [
        {
          field: 'videoUrl',
          message: 'Only an https link can be stored, because it is opened from a page served over https',
        },
      ],
    });
  }
  return parsed.toString();
}

/** A duration is either absent or a whole number of minutes that has not already passed. */
function durationFrom(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    // The schema says the same thing with `check (duration_minutes is null or
    // duration_minutes >= 0)`, and a CHECK violation would arrive as a 500 whose
    // message the error middleware withholds in production. The caller typed a
    // negative number; that deserves a 400 saying so.
    throw new HttpError(400, 'The length of the consultation must be zero minutes or more', {
      code: 'validation_failed',
      details: [{ field: 'durationMinutes', message: 'Enter a whole number of minutes' }],
    });
  }
  return value;
}

function instantFrom(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, 'Enter the date and time of the appointment', {
      code: 'validation_failed',
      details: [{ field, message: 'That is not a date and time' }],
    });
  }
  return parsed.toISOString();
}

/**
 * Checks that the person named as holding the appointment works here, and may.
 *
 * ## Why this exists
 *
 * `conducted_by` is `uuid references users (id)` with no pharmacy in the
 * reference, because a user's pharmacy is a column on `users` and Postgres cannot
 * put a two-table condition into a foreign key. So the schema will happily store
 * the id of a pharmacist who works at a different pharmacy entirely, and nothing
 * downstream errors: the repository returns the bare uuid, and the diary filter
 * `conducted_by = $4::uuid` simply matches nothing.
 *
 * Two consequences, and the second is the reason this is not deferred. The row is
 * wrong the moment it is written — an appointment attributed to somebody who was
 * never in the building, which is the same category of error as a screening
 * attributed to whoever the client said took it. And the day anybody renders the
 * conductor's name on the consultation page, which is the first thing that page
 * will want, a join across `users` turns a wrong uuid into one pharmacy reading
 * another's staff list.
 *
 * This is `sales.service.ts`'s `resolveApprover` with the permission changed, and
 * the shape is copied deliberately: tenant first, then `isActive`, then the role.
 * Tenant first because a miss and a wrong-tenant answer have to be
 * indistinguishable — `notFound` says "no member of staff matches that id"
 * whether the id is nonsense or belongs to a competitor, and a caller cannot probe
 * which.
 *
 * The permission asked for is `consultations:write`, not a clinical role. That is
 * the permission to *book* one, so naming a conductor and booking an appointment
 * are held by the same set of people and a caller cannot book one for somebody
 * who could not have booked it themselves. Counter staff hold neither, so a
 * consultation cannot be attributed to the till.
 *
 * Resolved outside the transaction for the reason `resolveApprover` gives:
 * `findUserById` reads through the module-level pool and cannot join a
 * transaction, so calling this inside one would be a claim about all-or-nothing
 * that the code cannot back.
 */
async function resolveConductor(pharmacyId: string, userId: string): Promise<string> {
  const user = await findUserById(userId);
  if (user === null || user.pharmacyId !== pharmacyId) throw notFound('member of staff');
  if (!user.isActive) {
    throw new HttpError(
      400,
      `${user.fullName} cannot hold this consultation: that login is no longer active`,
      { code: 'conductor_inactive', details: { field: 'conductedBy' } }
    );
  }
  if (!can(user.role, 'consultations:write')) {
    throw new HttpError(
      400,
      `${user.fullName} cannot hold this consultation. A pharmacist or the owner has to.`,
      { code: 'conductor_not_permitted', details: { field: 'conductedBy' } }
    );
  }
  return user.id;
}

/**
 * The patch value for `conductedBy`, resolved.
 *
 * Three cases and not two, because a reschedule is a patch: `undefined` means
 * "leave the assignment alone" and has to survive as `undefined` or the
 * repository's `case when $8::boolean` would read it as an explicit clear. `null`
 * means "unassign", which is legitimate on its own — a pharmacist calling in sick
 * leaves the appointment booked and unheld rather than cancelled — and needs no
 * lookup. Only a non-empty string names somebody and gets checked.
 */
async function conductorFrom(
  pharmacyId: string,
  value: string | null | undefined
): Promise<string | null | undefined> {
  if (value === undefined || value === null) return value;
  return resolveConductor(pharmacyId, value);
}

/**
 * The sentence a patient receives, and the instant it becomes due.
 *
 * Null when the appointment has already happened, which is not an edge case: a
 * consultation booked for a time that has passed is a record of something that
 * took place, and a reminder for it would be a text telling somebody to attend an
 * appointment they were sitting in. Nothing is scheduled, and nothing is
 * superseded, because nothing was ever raised.
 *
 * The due instant is the lead time before the appointment, or now when that is
 * already past. A booking made three hours ahead still gets its reminder — on the
 * next scheduler run rather than a day early — because `due_at` cannot precede the
 * row that holds it.
 *
 * The body is plain ASCII on purpose. `A&B`, a hyphen and a full stop are all in
 * GSM 7-bit's default alphabet; a curly quote or an em dash is not, and one
 * character outside it moves the whole message to UCS-2, which halves the
 * characters a segment carries. `SMS_BODY_MAX_LENGTH` is stated in those terms.
 */
export function appointmentReminderFor(
  scheduledAtIso: string,
  now: string
): { dueAt: string; message: string } | null {
  const when = Date.parse(scheduledAtIso);
  const nowMs = Date.parse(now);
  if (Number.isNaN(when) || Number.isNaN(nowMs)) return null;
  if (when <= nowMs) return null;

  const at = new Date(when);
  const message =
    `Your appointment at ${PHARMACY_NAME} is on ${DAY_FORMAT.format(at)} at ` +
    `${TIME_FORMAT.format(at)}. Please call the pharmacy if you need to change it.`;

  if (message.length > SMS_BODY_MAX_LENGTH) {
    // Unreachable with today's formats, and asserted rather than truncated: a
    // message cut mid-sentence is one the patient cannot act on, and the honest
    // response to a body that will not fit is a failure somebody can see.
    throw new Error(
      `the appointment reminder is ${message.length} characters and the limit is ${SMS_BODY_MAX_LENGTH}`
    );
  }

  return {
    dueAt: new Date(Math.max(when - APPOINTMENT_REMINDER_LEAD_MS, nowMs)).toISOString(),
    message,
  };
}

/**
 * Books a consultation and raises its reminder in the same transaction.
 *
 * `consultations:write`.
 */
export async function bookConsultation(
  actor: Actor,
  input: ConsultationInput
): Promise<ConsultationView> {
  const now = nowIso();
  const scheduledAt = instantFrom(input.scheduledAt, 'scheduledAt');
  const videoUrl = videoUrlFrom(input.videoUrl);
  const durationMinutes = durationFrom(input.durationMinutes);
  const conductedBy = await conductorFrom(actor.pharmacyId, input.conductedBy);

  return withTransaction(async (client) => {
    // Inside the transaction, so the consultation cannot be written against a
    // patient who was removed a moment earlier. Without the lookup the foreign key
    // answers instead, and a constraint name in a response is a schema disclosure
    // as well as the wrong status.
    const patient = await findPatient(client, actor.pharmacyId, input.patientId);
    if (patient === null) throw notFound('patient');

    const row = await createConsultation(client, {
      pharmacyId: actor.pharmacyId,
      patientId: input.patientId,
      conductedBy: conductedBy ?? null,
      type: input.type,
      scheduledAt,
      durationMinutes,
      videoUrl,
      notes: input.notes ?? null,
    });

    // The key is built from `row.scheduledAt` and not from the `scheduledAt`
    // parsed above, even though the two describe one instant. The row's value is
    // what the database stored and what every later read maps back out, so it is
    // the only spelling that a reschedule can reproduce to find this reminder by
    // prefix. Two spellings of one instant here would be two keys, and the second
    // one would never match anything.
    const planned = appointmentReminderFor(row.scheduledAt, now);
    if (planned !== null) {
      await scheduleReminder(client, {
        pharmacyId: actor.pharmacyId,
        patientId: row.patientId,
        kind: 'appointment',
        dueAt: planned.dueAt,
        message: planned.message,
        dedupeKey: appointmentReminderKey(row.id, row.scheduledAt),
      });
    }

    return row;
  });
}

/**
 * Moves a consultation and its reminder together. `consultations:write`.
 *
 * Only a `scheduled` consultation can move. One that has been completed,
 * cancelled or missed is a record of what happened, and reopening it to change the
 * time would be a way to un-record it.
 */
export async function rescheduleConsultation(
  actor: Actor,
  consultationId: string,
  input: RescheduleInput
): Promise<ConsultationView> {
  const now = nowIso();
  const scheduledAt = instantFrom(input.scheduledAt, 'scheduledAt');
  // `videoUrlFrom` and `durationFrom` both answer null for "nothing was given",
  // which is the right answer for a booking — an appointment nobody said a length
  // for has no length — and the wrong one for a patch. `updateConsultation` reads
  // `undefined` as "leave this column alone" and `null` as "clear it", so
  // collapsing the two here would take the meeting link and the length away from
  // every appointment moved by a form that posted only the new time, and the row
  // would still look perfectly ordinary afterwards.
  const videoUrl = input.videoUrl === undefined ? undefined : videoUrlFrom(input.videoUrl);
  const durationMinutes =
    input.durationMinutes === undefined ? undefined : durationFrom(input.durationMinutes);
  // Moving a video consultation to a counter visit has to lose the link, and the
  // repository can only clear a column when the caller says so explicitly: a
  // `coalesce` would keep handing out an address for a meeting that is no longer
  // happening online. `clearingVideoUrl` is the one thing that turns an
  // "unmentioned" into a "clear it", and it is a decision about the type rather
  // than about the link — so a reschedule that says `in_person` without restating
  // the link still drops it, while one that says nothing about either keeps it.
  const type = input.type;
  const clearingVideoUrl = type !== undefined && type !== 'video';
  const conductedBy = await conductorFrom(actor.pharmacyId, input.conductedBy);

  return withTransaction(async (client) => {
    const existing = await findConsultation(client, actor.pharmacyId, consultationId);
    if (existing === null) throw notFound('consultation');

    const row = await updateConsultation(client, actor.pharmacyId, consultationId, {
      scheduledAt,
      ...(type === undefined ? {} : { type }),
      conductedBy,
      durationMinutes,
      videoUrl: clearingVideoUrl ? null : videoUrl,
      notes: input.notes,
      allowedFrom: MOVABLE_FROM,
    });
    if (row === null) {
      // Found a line above and refused by the guard, so this is the status rather
      // than the id: the consultation is there and is no longer `scheduled`.
      throw new HttpError(
        409,
        `This consultation is ${existing.status}, so its time can no longer be changed`,
        { code: 'consultation_not_movable', details: { status: existing.status } }
      );
    }

    // Supersede before scheduling. Both are in one transaction, so the order
    // cannot leave a half-done state — a throw rolls the pair back together — and
    // the new key is protected either way by the `dedupe_key <> $2` clause. The
    // order is still the readable one: stop telling the patient about the old slot,
    // then tell them about the new one.
    const keepDedupeKey = appointmentReminderKey(row.id, row.scheduledAt);
    await supersedeAppointmentReminders(
      client,
      actor.pharmacyId,
      row.id,
      keepDedupeKey,
      `The appointment moved to ${DAY_FORMAT.format(new Date(row.scheduledAt))} at ` +
        `${TIME_FORMAT.format(new Date(row.scheduledAt))}, so this reminder is for a time that is no longer booked.`
    );

    const planned = appointmentReminderFor(row.scheduledAt, now);
    if (planned !== null) {
      await scheduleReminder(client, {
        pharmacyId: actor.pharmacyId,
        patientId: row.patientId,
        kind: 'appointment',
        dueAt: planned.dueAt,
        message: planned.message,
        dedupeKey: keepDedupeKey,
      });
    }

    return row;
  });
}

/**
 * Ends a consultation, and with it any reminder still pending for it.
 *
 * `consultations:write`. One function for all three endings because the reminder
 * rule is the same for each and only the sentence differs; three functions would
 * be three places to forget it.
 */
export async function endConsultation(
  actor: Actor,
  consultationId: string,
  status: Exclude<ConsultationStatus, 'scheduled'>
): Promise<ConsultationView> {
  return withTransaction(async (client) => {
    const existing = await findConsultation(client, actor.pharmacyId, consultationId);
    if (existing === null) throw notFound('consultation');

    const row = await updateConsultation(client, actor.pharmacyId, consultationId, {
      status,
      allowedFrom: MOVABLE_FROM,
    });
    if (row === null) {
      throw new HttpError(
        409,
        `This consultation is ${existing.status}, so it cannot be marked ${status.replace('_', ' ')}`,
        { code: 'consultation_not_movable', details: { status: existing.status } }
      );
    }

    // Nothing is kept. Whatever is still pending for this consultation is for an
    // appointment that has now ended, and a reminder that fires afterwards tells a
    // patient to attend something that already happened. The count is not
    // returned to the caller because there is nothing to do with it: zero is the
    // normal answer, since the reminder usually fired a day before the slot.
    await supersedeAppointmentReminders(
      client,
      actor.pharmacyId,
      row.id,
      SUPERSEDE_ALL_KEYS,
      ENDED_REASON[status]
    );

    return row;
  });
}

/** `patients:read`, because a diary is read by the same people as a record. */
export async function getConsultation(
  pharmacyId: string,
  consultationId: string
): Promise<ConsultationView> {
  const row = await findConsultation(poolSql, pharmacyId, consultationId);
  if (row === null) throw notFound('consultation');
  return row;
}

/**
 * The diary. `patients:read`.
 *
 * No total, and that is a decision rather than a gap: both of this list's real
 * views are "what is coming up" and "the last few", and neither shows a count. A
 * second query per page load would buy a number nobody reads.
 */
export async function listConsultationPage(
  pharmacyId: string,
  filters: ConsultationFilters
): Promise<ConsultationPage> {
  return { consultations: await listConsultations(poolSql, pharmacyId, filters) };
}
