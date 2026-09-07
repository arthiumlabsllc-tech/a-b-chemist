import { Router } from 'express';
import { body, param } from 'express-validator';
import { authorize } from '../middleware/authorize';
import { requireAuth } from '../middleware/authenticate';
import {
  changePatient,
  getPatient,
  listPatientPage,
  PATIENT_LIMITS,
  registerPatient,
  type PatientInput,
} from '../services/patients.service';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/http';
import { GENDERS } from '../utils/schema-enums';
import { runValidation } from '../utils/validate';
import { actorOf, idParam, pageOf, pagination, searchQuery } from './shared';

/**
 * Patient records: the register, the search box, and the four clinical lists.
 *
 * Mounted behind `authenticate` alone, with `authorize` naming the permission on
 * each route — the shape `routes/index.ts` describes for a router whose reads and
 * writes are held by different roles. Counter staff hold `patients:read` and
 * `patients:write` and can open and edit a record at the counter; the screenings,
 * consultations and prescriptions that hang off it are each behind their own
 * permission on their own router.
 *
 * ## Why the sub-domains are separate routers rather than nested paths
 *
 * There is no `GET /patients/:id/screenings` here, and the omission is deliberate.
 * Every one of those repositories already takes `patientId` as a filter, so
 * `GET /screenings?patientId=...` is the same question asked through the module
 * that owns it. Nested routes would be a second path to the same statement, which
 * means two entries in the route table, two places to authorise, and two ways for
 * the id in the path and the id in the filter to disagree.
 *
 * ## No format check on the phone number
 *
 * The same rule `staff.routes.ts` records, for the same reason: a validator that
 * rejects a Ghanaian number the pharmacist knows is correct teaches them to type
 * something false, and a false number is worse than an oddly formatted one. What the
 * number decides is whether a reminder can be texted, and `services/patients.service.ts`
 * reports that as `smsNumber` on the record rather than refusing the record.
 */
export const patientsRoutes = Router();

/**
 * The three clinical lists, validated identically.
 *
 * Built from one helper rather than written three times. The copies would agree
 * today, and the day one of them was edited — a longer cap on medications, say —
 * nothing would fail and the difference would be invisible until a record was
 * refused for a reason the form did not show.
 *
 * ## One message for the list, two for an entry
 *
 * The list chain carries a single default message and no `.withMessage`, which is
 * the shape `routes/shared.ts` uses for a search and `inventory.routes.ts` for a
 * body field. It had a `.withMessage` first, and that was a defect rather than a
 * style: `isArray({ min, max })` is the only validator on the chain, so the
 * override was the message every failure got and the default was unreachable. A
 * caller who posted `"Penicillin"` instead of `["Penicillin"]` was told the list
 * holds at most a hundred entries, which is a true sentence about the wrong
 * problem — and the sentence that named the actual one could never be seen.
 *
 * The entry chain keeps both, because there the two failures are genuinely
 * different and both reachable: a number where a name belongs, and a name past
 * two hundred characters.
 */
function clinicalList(field: 'allergies' | 'conditions' | 'medications') {
  const label = field === 'allergies' ? 'allergy' : field.slice(0, -1);
  const { min, max } = PATIENT_LIMITS.listLength;
  return [
    body(field, `Enter ${field} as a list of ${max} entries or fewer`)
      .optional({ values: 'null' })
      .isArray({ min, max }),
    body(`${field}.*`, `Enter each ${label} as text`)
      .isString()
      .trim()
      .isLength({ min: PATIENT_LIMITS.listItem.min, max: PATIENT_LIMITS.listItem.max })
      .withMessage(`Each ${label} must be between ${PATIENT_LIMITS.listItem.min} and ${PATIENT_LIMITS.listItem.max} characters`),
  ];
}

/**
 * The record, shared by POST and PATCH.
 *
 * Shared because the two must accept the same fields or a form that saved once
 * stops saving on edit. The one difference is that every field is optional on a
 * PATCH, which is what makes it a patch: `undefined` means "leave it alone" and
 * `null` means "clear it", and `services/patients.service.ts` builds its patch field
 * by field to keep that distinction alive through a request body.
 *
 * `fullName` is required on a POST and optional on a PATCH; the other four are
 * optional on both. A patient with no name is a record nobody can find again, and
 * the search box that is supposed to bring it back has nothing to match on — but a
 * patient with no known birth date, no phone, no stated gender and no notes is an
 * ordinary registration, and refusing it would teach the counter to invent values
 * for fields the patient declined to answer.
 *
 * `.optional()` is written first on every chain rather than appended to a finished
 * one. express-validator accepts the call anywhere and the result is the same, but
 * every other route file in this codebase spells it first — and a chain built in one
 * order here and read in another there is two shapes for one idea, which is how a
 * route ends up required when it was meant to be optional.
 */
function patientBody(patch: boolean) {
  const name = patch
    ? body('fullName', "Enter the patient's full name").optional({ values: 'null' })
    : body('fullName', "Enter the patient's full name");

  return [
    name
      .isString()
      .trim()
      .isLength({ min: PATIENT_LIMITS.fullName.min, max: PATIENT_LIMITS.fullName.max })
      .withMessage(
        `Enter a full name of between ${PATIENT_LIMITS.fullName.min} and ${PATIENT_LIMITS.fullName.max} characters`
      ),
    body('dateOfBirth', 'Enter the date of birth as YYYY-MM-DD')
      .optional({ values: 'null' })
      .isDate({ format: 'YYYY-MM-DD', strictMode: true })
      .withMessage('Enter the date of birth as YYYY-MM-DD'),
    body('phone', 'Enter the phone number as text')
      .optional({ values: 'null' })
      .isString()
      .trim()
      .isLength({ max: PATIENT_LIMITS.phone.max })
      .withMessage('That phone number is too long'),
    body('gender', `Gender must be one of ${GENDERS.join(', ')}`)
      .optional({ values: 'null' })
      .isIn(GENDERS),
    body('notes', 'Enter the notes as text')
      .optional({ values: 'null' })
      .isString()
      .trim()
      .isLength({ max: PATIENT_LIMITS.notes.max })
      .withMessage(`Notes must be ${PATIENT_LIMITS.notes.max} characters or fewer`),
    ...clinicalList('allergies'),
    ...clinicalList('conditions'),
    ...clinicalList('medications'),
  ];
}

patientsRoutes.get(
  '/',
  authorize('patients:read'),
  ...pagination,
  searchQuery(),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const raw = req.query as Record<string, unknown>;
    const { limit, offset } = pageOf(raw);
    // Trimmed to null rather than passed through as ''. The repository treats an
    // empty search as "every patient" anyway, but a filter that reaches SQL as an
    // empty string is one that a future edit could start matching literally.
    const search =
      typeof raw.search === 'string' && raw.search.trim() !== '' ? raw.search.trim() : null;

    sendOk(res, await listPatientPage(auth.pharmacyId, { search, limit, offset }));
  })
);

patientsRoutes.post(
  '/',
  authorize('patients:write'),
  ...patientBody(false),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const input = req.body as PatientInput;
    // 201 rather than 200: the record did not exist before this request, and a
    // create that answers like a read is one a retry cannot tell apart.
    sendOk(res, { patient: await registerPatient(actorOf(req), input) }, 201);
  })
);

patientsRoutes.get(
  '/:id',
  authorize('patients:read'),
  param('id').isUUID().withMessage('That is not a valid patient id'),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const patientId = idParam(req.params.id, 'patient');
    sendOk(res, { patient: await getPatient(auth.pharmacyId, patientId) });
  })
);

patientsRoutes.patch(
  '/:id',
  authorize('patients:write'),
  param('id').isUUID().withMessage('That is not a valid patient id'),
  ...patientBody(true),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const patientId = idParam(req.params.id, 'patient');
    sendOk(res, { patient: await changePatient(actorOf(req), patientId, req.body as PatientInput) });
  })
);
