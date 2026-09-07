import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authorize } from '../middleware/authorize';
import { requireAuth } from '../middleware/authenticate';
import {
  approvePrescription,
  correctPrescription,
  dispensePrescription,
  getPrescription,
  listPrescriptionPage,
  PRESCRIPTION_LIMITS,
  recordPrescription,
  rejectPrescription,
  type PrescriptionCorrection,
  type PrescriptionInput,
} from '../services/prescriptions.service';
import { asyncHandler } from '../utils/async-handler';
import { toDateOnlyOrNull, toEnumMember } from '../utils/coerce';
import { sendOk } from '../utils/http';
import { PRESCRIPTION_STATUSES } from '../utils/schema-enums';
import { runValidation } from '../utils/validate';
import { actorOf, enumListFilter, idParam, OPTIONAL_QUERY, pageOf, pagination } from './shared';

/**
 * Prescriptions: the queue, the four fields on the record, and the three moves.
 *
 * Mounted behind `authenticate` alone, with `authorize` naming the permission on
 * each route — and this router is the one where the split matters most, because
 * reading a prescription, writing one down and approving one are three different
 * acts held by three different sets of people.
 *
 * ## Why recording is `patients:write` and not `prescriptions:approve`
 *
 * Writing down that a customer handed a script across the counter is the same kind
 * of act as noting an allergy: it is putting something on a record, and counter
 * staff hold `patients:write` for exactly that. Making the two permissions the same
 * would mean only a pharmacist could write down what was in front of them, which is
 * a queue that starts at the till rather than at the dispensary.
 *
 * The control is that recording and approving are different permissions, so the
 * person who wrote it down cannot be the person who approved it unless they are a
 * pharmacist or the owner — and that holds on a shift where the owner is the one at
 * the counter, because `prescriptions:approve` is simply not in the staff permission
 * set. This is the shape `sales.service.ts` describes for `resolveApprover`: the
 * control is on the role, not on the combination.
 *
 * ## Why correcting is `prescriptions:approve`
 *
 * A correction can re-attach a prescription to a different patient, which moves a
 * clinical record off one person and onto another. That is a heavier act than
 * writing one down, and it is the same weight of act as approving — so it is the
 * same permission. Counter staff ask a pharmacist.
 *
 * ## Route order
 *
 * There is no literal path on this router, so no ordering hazard of the kind
 * `inventory.routes.ts` documents. The three moves are `/:id/approve`,
 * `/:id/dispense` and `/:id/reject` rather than one `/:id/move` with the target in
 * the body — the opposite of the choice `consultations.routes.ts` makes for
 * `/end`, and for a reason: each of these is a permission-checked clinical act in
 * its own right and each will want its own audit line, whereas ending an
 * appointment is one act with three outcomes.
 */
export const prescriptionsRoutes = Router();

/**
 * The four fields on the record, shared by recording and correcting.
 *
 * All four are optional on both. On a correction that is what makes it a patch —
 * `undefined` means "leave it alone", `null` means "clear it", and
 * `correctPrescription` refuses a body where every field is absent. On a recording
 * it means a script can be written down before the patient has been found in the
 * register, which is the ordinary order of events at a busy counter: the paper
 * arrives first.
 */
function prescriptionBody() {
  return [
    body('patientId', 'That is not a valid patient id').optional({ values: 'null' }).isUUID(),
    body('saleId', 'That is not a valid sale id').optional({ values: 'null' }).isUUID(),
    body('prescriberName', 'Enter the prescriber as text')
      .optional({ values: 'null' })
      .isString()
      .trim()
      .isLength({
        min: PRESCRIPTION_LIMITS.prescriberName.min,
        max: PRESCRIPTION_LIMITS.prescriberName.max,
      })
      .withMessage(
        `A prescriber's name must be ${PRESCRIPTION_LIMITS.prescriberName.max} characters or fewer`
      ),
    body('notes', 'Enter the notes as text')
      .optional({ values: 'null' })
      .isString()
      .trim()
      .isLength({ min: PRESCRIPTION_LIMITS.notes.min, max: PRESCRIPTION_LIMITS.notes.max })
      .withMessage(`Notes must be ${PRESCRIPTION_LIMITS.notes.max} characters or fewer`),
  ];
}

const PRESCRIPTION_STATUS_SET: ReadonlySet<string> = new Set(PRESCRIPTION_STATUSES);

/**
 * Reads the four fields as a patch, keeping absent and null apart.
 *
 * Field by field rather than a cast over the body, because `null` clears a column
 * and `undefined` leaves it, and a cast that turned an absent key into a null one
 * would erase a patient link nobody asked it to.
 *
 * Typed as `PrescriptionCorrection` and not as a generic over the two input
 * interfaces, and the assignment at the POST below is what keeps that honest:
 * `const input: PrescriptionInput = fieldsFrom(...)` is checked against
 * `PrescriptionInput`, so a field added to the create contract as required fails
 * the build here rather than arriving null. The two interfaces are field for field
 * identical today — a generic parameterised over them would have needed an `as` on
 * the way out, which is an assertion rather than a check.
 */
function fieldsFrom(raw: Record<string, unknown>): PrescriptionCorrection {
  return {
    ...(raw.patientId === undefined ? {} : { patientId: raw.patientId as string | null }),
    ...(raw.saleId === undefined ? {} : { saleId: raw.saleId as string | null }),
    ...(raw.prescriberName === undefined
      ? {}
      : { prescriberName: raw.prescriberName as string | null }),
    ...(raw.notes === undefined ? {} : { notes: raw.notes as string | null }),
  };
}

// --- The queue ----------------------------------------------------------------

prescriptionsRoutes.get(
  '/',
  authorize('patients:read'),
  ...pagination,
  query('patientId', 'That is not a valid patient id').optional(OPTIONAL_QUERY).isUUID(),
  query('status', `Status must be one of ${PRESCRIPTION_STATUSES.join(', ')}`)
    .optional(OPTIONAL_QUERY)
    .custom((value: unknown) =>
      enumListFilter(value).every(
        (entry) => typeof entry === 'string' && PRESCRIPTION_STATUS_SET.has(entry)
      )
    ),
  query('from', 'Enter the start date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  query('to', 'Enter the end date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  query('order', "Order must be 'newest' or 'oldest'")
    .optional(OPTIONAL_QUERY)
    .isIn(['newest', 'oldest']),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const raw = req.query as Record<string, unknown>;
    const { limit, offset } = pageOf(raw);

    const page = await listPrescriptionPage(auth.pharmacyId, {
      patientId: raw.patientId === undefined || raw.patientId === '' ? null : String(raw.patientId),
      statuses: enumListFilter(raw.status).map((entry) =>
        toEnumMember(entry, PRESCRIPTION_STATUSES, 'the status filter')
      ),
      from: toDateOnlyOrNull(raw.from, 'the start date'),
      to: toDateOnlyOrNull(raw.to, 'the end date'),
      // Left absent rather than defaulted to `'newest'` here, so the default stays
      // in the repository that owns the ordering. An approval queue asks for
      // `'oldest'` explicitly, which is the case that reads better for a name in
      // the URL than a name in a comment.
      ...(raw.order === undefined || raw.order === ''
        ? {}
        : { order: toEnumMember(raw.order, ['newest', 'oldest'] as const, 'the order') }),
      limit,
      offset,
    });

    // `total` is in the page rather than added here: the badge on an approval queue
    // has to count the same rows the list was filtered to, and two numbers from two
    // calls are two numbers that can disagree.
    sendOk(res, { ...page, statuses: PRESCRIPTION_STATUSES });
  })
);

// --- Writing one down ---------------------------------------------------------

prescriptionsRoutes.post(
  '/',
  authorize('patients:write'),
  ...prescriptionBody(),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const input: PrescriptionInput = fieldsFrom(req.body as Record<string, unknown>);
    // 201: the prescription did not exist before this request. It arrives as
    // `pending`, and `approvedBy` is not a field on this body — an approver on a
    // prescription nobody has approved is a signature on a decision nobody made.
    sendOk(res, { prescription: await recordPrescription(actorOf(req), input) }, 201);
  })
);

// --- One prescription ---------------------------------------------------------

prescriptionsRoutes.get(
  '/:id',
  authorize('patients:read'),
  param('id').isUUID().withMessage('That is not a valid prescription id'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const prescriptionId = idParam(req.params.id, 'prescription');
    sendOk(res, { prescription: await getPrescription(auth.pharmacyId, prescriptionId) });
  })
);

prescriptionsRoutes.patch(
  '/:id',
  authorize('prescriptions:approve'),
  param('id').isUUID().withMessage('That is not a valid prescription id'),
  ...prescriptionBody(),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const prescriptionId = idParam(req.params.id, 'prescription');
    const correction = fieldsFrom(req.body as Record<string, unknown>);
    sendOk(res, {
      prescription: await correctPrescription(actorOf(req), prescriptionId, correction),
    });
  })
);

// --- The three moves ----------------------------------------------------------

prescriptionsRoutes.post(
  '/:id/approve',
  authorize('prescriptions:approve'),
  param('id').isUUID().withMessage('That is not a valid prescription id'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const prescriptionId = idParam(req.params.id, 'prescription');
    // Approving raises the collection reminder in the same transaction, so a 200
    // here means the row moved and the reminder exists. That is the guarantee the
    // bell depends on, and it is why this goes through the service rather than
    // `updatePrescription` directly.
    sendOk(res, { prescription: await approvePrescription(actorOf(req), prescriptionId) });
  })
);

prescriptionsRoutes.post(
  '/:id/dispense',
  authorize('prescriptions:approve'),
  param('id').isUUID().withMessage('That is not a valid prescription id'),
  // The sale the medicine went out against. Optional: a prescription is dispensed
  // against a sale most of the time, and the link is worth recording, but making it
  // required would mean a pharmacist could not mark medicine as handed over until
  // somebody had found the receipt.
  body('saleId', 'That is not a valid sale id').optional({ values: 'null' }).isUUID(),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const prescriptionId = idParam(req.params.id, 'prescription');
    const raw = req.body as Record<string, unknown>;
    const saleId = raw.saleId === undefined ? null : (raw.saleId as string | null);

    // Dispensing supersedes the collection reminder. Without that the patient is
    // texted tomorrow about medicine they are holding, which is the exact failure
    // `utils/reminder-keys.ts` names as the reason a refill key carries no month.
    sendOk(res, { prescription: await dispensePrescription(actorOf(req), prescriptionId, saleId) });
  })
);

prescriptionsRoutes.post(
  '/:id/reject',
  authorize('prescriptions:approve'),
  param('id').isUUID().withMessage('That is not a valid prescription id'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const prescriptionId = idParam(req.params.id, 'prescription');
    // No reason is taken here, and that is a gap rather than a choice to hide one.
    // The table has a single free-text `notes` column and no refusal reason of its
    // own: composing a reason into `notes` would either overwrite what a pharmacist
    // wrote or append in a format nothing can parse. A reason of its own is a
    // column, and a column is a migration to decide with A&B rather than to invent
    // here. The refusal itself is recorded, with its status and its `updated_at`.
    sendOk(res, { prescription: await rejectPrescription(actorOf(req), prescriptionId) });
  })
);
