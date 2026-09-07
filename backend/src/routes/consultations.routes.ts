import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authorize } from '../middleware/authorize';
import { requireAuth } from '../middleware/authenticate';
import {
  bookConsultation,
  endConsultation,
  getConsultation,
  listConsultationPage,
  rescheduleConsultation,
  type ConsultationInput,
  type RescheduleInput,
} from '../services/consultations.service';
import { asyncHandler } from '../utils/async-handler';
import { toDateOnlyOrNull, toEnumMember } from '../utils/coerce';
import { sendOk } from '../utils/http';
import {
  CONSULTATION_STATUSES,
  CONSULTATION_TYPES,
  type ConsultationStatus,
} from '../utils/schema-enums';
import { runValidation } from '../utils/validate';
import { actorOf, enumListFilter, idParam, OPTIONAL_QUERY, pageOf, pagination } from './shared';

/**
 * The consultation diary: booking, moving, ending, and reading it back.
 *
 * Mounted behind `authenticate` alone, with `authorize` naming the permission on
 * each route. The diary is `patients:read` — it is part of the record the counter
 * may already open — while booking and moving are `consultations:write`, which
 * counter staff do not hold.
 *
 * ## One `/end` route with the status in the body, not three literal routes
 *
 * `POST /consultations/:id/complete`, `/cancel` and `/no-show` would each need
 * their own entry, their own `authorize`, and their own test, and would all call
 * the same function with a different argument — because `endConsultation` is
 * written as one function taking a status, on the grounds that all three do the
 * same three things: move the row out of `scheduled`, refuse if it already moved,
 * and supersede whatever reminder is still pending. Three routes over one
 * behaviour is three places for the two to drift.
 *
 * The one cost is that the status arrives in a body rather than in the path, so
 * the route has to say which values it accepts. `ENDED_STATUSES` below is derived
 * from the enum rather than written out, which keeps that honest.
 *
 * ## No `videoUrl` format check beyond "it is text"
 *
 * The scheme rule is `videoUrlFrom`'s, and it is an allowlist of `https:` written
 * with `new URL` rather than a blocklist of the schemes somebody thought of.
 * Repeating it here with `.isURL({ protocols: ['https'] })` would be a second
 * implementation of a security rule, and the two would be checked against
 * different inputs — this one against the raw body, that one against the trimmed
 * string. What this file guarantees is only that a string arrived, which is what
 * `videoUrlFrom` is typed to take.
 */
export const consultationsRoutes = Router();

/** A remark beside an appointment. Short, and capped here rather than in the column. */
const MAX_NOTES_LENGTH = 500;

/**
 * A meeting link. `video_url` is `text` with no limit, so this is the only cap.
 *
 * 2048 is longer than any real meeting address and shorter than anything worth
 * storing: the value ends up in an `href` on the consultation page, and a text
 * column that becomes a link attribute is where an unbounded field stops being a
 * harmless one.
 */
const MAX_VIDEO_URL_LENGTH = 2048;

/**
 * The three ways an appointment ends, derived from the enum.
 *
 * Written as a filtered copy of `CONSULTATION_STATUSES` and not as a second
 * literal list, because a list of `['completed', 'cancelled', 'no_show']` here
 * would be a copy that agrees today. If a fourth ending were ever added to the
 * enum, the copy would keep accepting three and nothing would fail.
 *
 * The type predicate is what makes this usable without a cast. A plain `.filter`
 * over a union returns the whole union, so `toEnumMember` would hand back
 * `ConsultationStatus` and passing it to `endConsultation` — which takes
 * `Exclude<ConsultationStatus, 'scheduled'>` — would need an assertion that the
 * filter did its job. The predicate puts that claim where the compiler can check
 * it, and `'scheduled'` genuinely cannot come out of the other side.
 */
const ENDED_STATUSES = CONSULTATION_STATUSES.filter(
  (status): status is Exclude<ConsultationStatus, 'scheduled'> => status !== 'scheduled'
);

/** Accepted repeatedly (`?status=scheduled&status=completed`) as well as once. */
const CONSULTATION_STATUS_SET: ReadonlySet<string> = new Set(CONSULTATION_STATUSES);

/**
 * A whole number of minutes, as a JSON number.
 *
 * A `.custom` rather than `.isInt()`, and the difference is not pedantry.
 * express-validator stringifies a value before handing it to a standard validator,
 * so `.isInt()` accepts `"30"` — and `durationFrom` in the service is typed
 * `number | null | undefined`, so `"30"` would pass this file and be refused there
 * with a sentence about whole numbers. That is the right answer arriving from the
 * wrong layer, after a validator that said the value was fine. Asking for a number
 * here keeps both layers asking the same question.
 *
 * The `>= 0` half does duplicate the service's check, and deliberately: the schema
 * says it with `check (duration_minutes is null or duration_minutes >= 0)`, so a
 * negative value that reached the database would come back as a 500 whose message
 * the error middleware withholds.
 *
 * Optional on both a booking and a reschedule, so this takes no `patch` argument.
 * A length nobody gave is not a length of zero minutes, and the column is nullable
 * for exactly that reason.
 */
function durationMinutesField() {
  return body(
    'durationMinutes',
    'Enter the length of the consultation as a whole number of minutes'
  )
    .optional({ values: 'null' })
    .custom((value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

/**
 * The appointment fields, shared by booking and rescheduling.
 *
 * Shared for the reason `patients.routes.ts` gives: the two must accept the same
 * fields or a form that booked an appointment stops working when it edits one.
 * `patientId` is the exception and appears only on a booking — moving an
 * appointment to a different patient is a new appointment, and a reschedule that
 * could reassign the patient would be a way to change whose record a consultation
 * sits on without anything calling it that.
 *
 * `type` is the one field whose required-ness differs, and only it: a reschedule
 * that moved an in-person visit to next week should not have to restate that it is
 * in person. `scheduledAt` is required on both, because a reschedule with no new
 * time is not a reschedule.
 */
function appointmentBody(patch: boolean) {
  const type = body('type', `Type must be one of ${CONSULTATION_TYPES.join(', ')}`);

  return [
    body('scheduledAt', 'Enter the date and time of the appointment')
      .isISO8601()
      .withMessage('Enter the date and time of the appointment'),
    patch ? type.optional().isIn(CONSULTATION_TYPES) : type.isIn(CONSULTATION_TYPES),
    body('conductedBy', 'That is not a valid member of staff')
      .optional({ values: 'null' })
      .isUUID(),
    durationMinutesField(),
    body('videoUrl', 'Enter the meeting link as a full web address, starting https://')
      .optional({ values: 'null' })
      .isString()
      .trim()
      .isLength({ max: MAX_VIDEO_URL_LENGTH })
      .withMessage(`A meeting link must be ${MAX_VIDEO_URL_LENGTH} characters or fewer`),
    body('notes', 'Enter the notes as text')
      .optional({ values: 'null' })
      .isString()
      .trim()
      .isLength({ max: MAX_NOTES_LENGTH })
      .withMessage(`Notes must be ${MAX_NOTES_LENGTH} characters or fewer`),
  ];
}

// --- The diary ----------------------------------------------------------------

consultationsRoutes.get(
  '/',
  authorize('patients:read'),
  ...pagination,
  query('patientId', 'That is not a valid patient id').optional(OPTIONAL_QUERY).isUUID(),
  query('conductedBy', 'That is not a valid member of staff')
    .optional(OPTIONAL_QUERY)
    .isUUID(),
  query('status', `Status must be one of ${CONSULTATION_STATUSES.join(', ')}`)
    .optional(OPTIONAL_QUERY)
    .custom((value: unknown) =>
      enumListFilter(value).every(
        (entry) => typeof entry === 'string' && CONSULTATION_STATUS_SET.has(entry)
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

    const requested = enumListFilter(raw.status);

    const page = await listConsultationPage(auth.pharmacyId, {
      patientId: raw.patientId === undefined || raw.patientId === '' ? null : String(raw.patientId),
      statuses: requested.map((entry) =>
        toEnumMember(entry, CONSULTATION_STATUSES, 'the status filter')
      ),
      conductedBy:
        raw.conductedBy === undefined || raw.conductedBy === '' ? null : String(raw.conductedBy),
      from: toDateOnlyOrNull(raw.from, 'the start date'),
      to: toDateOnlyOrNull(raw.to, 'the end date'),
      // `'upcoming'` is the repository's default, so an absent filter is left
      // absent rather than spelled out here: the default belongs to the module
      // that owns the ordering, and a second copy of it in a route is a second
      // place to change when the diary's default reading order changes.
      ...(raw.order === undefined || raw.order === ''
        ? {}
        : { order: toEnumMember(raw.order, ['upcoming', 'recent'] as const, 'the order') }),
      limit,
      offset,
    });

    sendOk(res, {
      ...page,
      limit,
      offset,
      statuses: CONSULTATION_STATUSES,
      types: CONSULTATION_TYPES,
    });
  })
);

// --- Booking ------------------------------------------------------------------

consultationsRoutes.post(
  '/',
  authorize('consultations:write'),
  body('patientId', 'That is not a valid patient id').isUUID(),
  ...appointmentBody(false),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const raw = req.body as Record<string, unknown>;

    const input: ConsultationInput = {
      patientId: String(raw.patientId),
      type: toEnumMember(raw.type, CONSULTATION_TYPES, 'the consultation type'),
      scheduledAt: String(raw.scheduledAt),
      conductedBy: (raw.conductedBy as string | null | undefined) ?? null,
      durationMinutes: (raw.durationMinutes as number | null | undefined) ?? null,
      videoUrl: (raw.videoUrl as string | null | undefined) ?? null,
      notes: (raw.notes as string | null | undefined) ?? null,
    };

    // 201: the appointment did not exist before this request. The reminder is
    // raised inside the same transaction by the service, so a 201 here means both
    // the row and its reminder were written — which is the guarantee the bell
    // depends on, and the reason booking does not go straight to the repository.
    sendOk(res, { consultation: await bookConsultation(actorOf(req), input) }, 201);
  })
);

// --- One appointment ----------------------------------------------------------

consultationsRoutes.get(
  '/:id',
  authorize('patients:read'),
  param('id').isUUID().withMessage('That is not a valid consultation id'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const consultationId = idParam(req.params.id, 'consultation');
    sendOk(res, { consultation: await getConsultation(auth.pharmacyId, consultationId) });
  })
);

consultationsRoutes.patch(
  '/:id',
  authorize('consultations:write'),
  param('id').isUUID().withMessage('That is not a valid consultation id'),
  ...appointmentBody(true),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const consultationId = idParam(req.params.id, 'consultation');
    const raw = req.body as Record<string, unknown>;

    // Read field by field rather than cast over the whole body, because three
    // values here mean three different things and a cast would flatten them:
    // `undefined` is "leave it alone", `null` is "clear it" — which for
    // `conductedBy` unassigns the appointment and for `videoUrl` takes the link
    // away — and a value is "set it". The repository's `case when $n::boolean`
    // columns exist to carry exactly that distinction, and it only survives a
    // request body if nothing on the way turns an absent key into a null one.
    const input: RescheduleInput = {
      scheduledAt: String(raw.scheduledAt),
      ...(raw.type === undefined
        ? {}
        : { type: toEnumMember(raw.type, CONSULTATION_TYPES, 'the consultation type') }),
      ...(raw.conductedBy === undefined ? {} : { conductedBy: raw.conductedBy as string | null }),
      ...(raw.durationMinutes === undefined
        ? {}
        : { durationMinutes: raw.durationMinutes as number | null }),
      ...(raw.videoUrl === undefined ? {} : { videoUrl: raw.videoUrl as string | null }),
      ...(raw.notes === undefined ? {} : { notes: raw.notes as string | null }),
    };

    sendOk(res, { consultation: await rescheduleConsultation(actorOf(req), consultationId, input) });
  })
);

consultationsRoutes.post(
  '/:id/end',
  authorize('consultations:write'),
  param('id').isUUID().withMessage('That is not a valid consultation id'),
  body('status', `Status must be one of ${ENDED_STATUSES.join(', ')}`).isIn(ENDED_STATUSES),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const consultationId = idParam(req.params.id, 'consultation');
    const raw = req.body as Record<string, unknown>;

    const status = toEnumMember(raw.status, ENDED_STATUSES, 'the status');
    sendOk(res, { consultation: await endConsultation(actorOf(req), consultationId, status) });
  })
);
