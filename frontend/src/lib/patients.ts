/**
 * The pure logic behind `/patients`: turning a search box into a query, holding a
 * patient record as an editable draft, and diffing that draft against the stored
 * row so an edit sends only what moved.
 *
 * Kept out of the page for the reason `lib/inventory.ts` and `lib/staff.ts` give:
 * a query built inline in a `useEffect` cannot be tested without rendering the
 * page, and the two things that break silently here are the omit-empty rule and
 * the three clinical lists, which live in a textarea as one-per-line and in the
 * database as an array. Both are functions with tests that have been seen to fail.
 *
 * ## The three-way distinction on every nullable field
 *
 * `PATCH /patients/:id` reads an absent key as "leave it alone" and a present
 * `null` as "clear it" — the same contract `RescheduleBody` documents in
 * `lib/api-types.ts`. So `patientUpdateBody` sends a field only when it differs
 * from the stored row, and sends `null` (never `''`) to clear one. Posting all
 * eight fields on every save would be harmless to the data and bad to the audit:
 * `updated_at` would move on a save that changed nothing, and a record whose
 * timestamp says "edited today" when only the phone was corrected last month is a
 * record nobody can reason about.
 */

import type { CreatePatientBody, Gender, PatientView, UpdatePatientBody } from './api-types';
import { PATIENT_LIMITS } from './api-types';
import { daysSinceEpoch } from './dates';

// ---------------------------------------------------------------------------
// Filters and the list query
// ---------------------------------------------------------------------------

/**
 * The one filter control on `/patients`. As in `SalesFilters` and
 * `InventoryFilters`, the empty string is "not set", and `patientQueryFrom` is
 * what turns that into an omitted `search` parameter rather than an empty one —
 * the backend reads a missing `search` as "every patient" and `''` the same way,
 * but sending `?search=` is noise that says nothing.
 */
export interface PatientFilters {
  search: string;
}

export const EMPTY_PATIENT_FILTERS: PatientFilters = { search: '' };

/**
 * The query for `GET /patients`.
 *
 * Only `limit` and `offset` are always present; `search` is sent trimmed and only
 * when there is one, mirroring `productQueryFrom`.
 */
export function patientQueryFrom(
  filters: PatientFilters,
  limit: number,
  offset: number
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit, offset };
  const search = filters.search.trim();
  if (search !== '') query.search = search;
  return query;
}

/** Whether the search box is set, so the page knows to offer "Clear". */
export function patientFiltersActive(filters: PatientFilters): boolean {
  return filters.search.trim() !== '';
}

// ---------------------------------------------------------------------------
// The clinical lists: one textarea, one array
// ---------------------------------------------------------------------------

/**
 * A textarea of one-entry-per-line into the array the API stores.
 *
 * Blank lines and surrounding whitespace are dropped rather than kept as empty
 * entries, because `patients.routes.ts` validates each entry with
 * `isLength({ min: 1 })` — a stray blank line from a trailing newline would be an
 * empty string the server refuses, and the pharmacist would be told an allergy was
 * too short when what they left was a gap between two real ones.
 */
export function parseClinicalList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The array back into a textarea, one entry per line. The inverse of the above. */
export function formatClinicalList(entries: readonly string[]): string {
  return entries.join('\n');
}

/**
 * Whether two clinical lists hold the same entries in the same order.
 *
 * Order is compared rather than sorted, because `patientUpdateBody` uses this to
 * decide whether to send the list at all: a reordered list is still a change the
 * pharmacist made on purpose, and treating it as "unchanged" would silently drop
 * the edit. The column is an array and keeps whatever order arrives.
 */
export function sameClinicalList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => entry === b[index]);
}

// ---------------------------------------------------------------------------
// The editable draft
// ---------------------------------------------------------------------------

/**
 * The record form's own shape: every field a string the operator edits, with the
 * three clinical lists as one textarea each and the nullable scalars as `''` for
 * none. The conversion to and from the API's `string | null` and `string[]` lives
 * in `createPatientBody` and `patientUpdateBody`, so a form never handles a null.
 */
export interface PatientDraft {
  fullName: string;
  phone: string;
  dateOfBirth: string;
  gender: Gender | null;
  allergies: string;
  conditions: string;
  medications: string;
  notes: string;
}

export const EMPTY_PATIENT_DRAFT: PatientDraft = {
  fullName: '',
  phone: '',
  dateOfBirth: '',
  gender: null,
  allergies: '',
  conditions: '',
  medications: '',
  notes: '',
};

/** A draft seeded from a stored row, which is how the edit form is opened. */
export function patientDraftFrom(patient: PatientView): PatientDraft {
  return {
    fullName: patient.fullName,
    phone: patient.phone ?? '',
    dateOfBirth: patient.dateOfBirth ?? '',
    gender: patient.gender,
    allergies: formatClinicalList(patient.allergies),
    conditions: formatClinicalList(patient.conditions),
    medications: formatClinicalList(patient.medications),
    notes: patient.notes ?? '',
  };
}

/**
 * The trimmed value, or null when there is nothing there.
 *
 * One helper because the same three fields — phone, date of birth, notes — are all
 * `string | null` on the row and all edited as text. `''` never reaches the API as
 * `''`: the column holds null for "none", and `PatientView` reports null back, so a
 * draft that cleared a field has to send null for the diff to see it as cleared.
 */
function nullIfEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * What `POST /patients` is given. Every field is written out rather than spread,
 * so a form that left something blank sends an explicit null or empty array rather
 * than an absent key — the create is a whole record, not a patch, and the intent is
 * clearer stated than left to the server's defaults.
 */
export function createPatientBody(draft: PatientDraft): CreatePatientBody {
  return {
    fullName: draft.fullName.trim(),
    phone: nullIfEmpty(draft.phone),
    dateOfBirth: nullIfEmpty(draft.dateOfBirth),
    gender: draft.gender,
    allergies: parseClinicalList(draft.allergies),
    conditions: parseClinicalList(draft.conditions),
    medications: parseClinicalList(draft.medications),
    notes: nullIfEmpty(draft.notes),
  };
}

/**
 * Only the fields that moved, as `PATCH /patients/:id` wants them. See the module
 * docstring for why this is the part that matters. Text is trimmed before
 * comparing because the server trims on the way in, so `' Kwame '` against a stored
 * `'Kwame'` is not a change; each clinical list is compared entry-wise with
 * `sameClinicalList`; a cleared nullable becomes `null`, never `''`.
 */
export function patientUpdateBody(original: PatientView, draft: PatientDraft): UpdatePatientBody {
  const body: UpdatePatientBody = {};

  const fullName = draft.fullName.trim();
  if (fullName !== original.fullName) body.fullName = fullName;

  const phone = nullIfEmpty(draft.phone);
  if (phone !== original.phone) body.phone = phone;

  const dateOfBirth = nullIfEmpty(draft.dateOfBirth);
  if (dateOfBirth !== original.dateOfBirth) body.dateOfBirth = dateOfBirth;

  if (draft.gender !== original.gender) body.gender = draft.gender;

  const allergies = parseClinicalList(draft.allergies);
  if (!sameClinicalList(allergies, original.allergies)) body.allergies = allergies;

  const conditions = parseClinicalList(draft.conditions);
  if (!sameClinicalList(conditions, original.conditions)) body.conditions = conditions;

  const medications = parseClinicalList(draft.medications);
  if (!sameClinicalList(medications, original.medications)) body.medications = medications;

  const notes = nullIfEmpty(draft.notes);
  if (notes !== original.notes) body.notes = notes;

  return body;
}

/** True when `patientUpdateBody` would send nothing, so Save should be held. */
export function patientUnchanged(original: PatientView, draft: PatientDraft): boolean {
  return Object.keys(patientUpdateBody(original, draft)).length === 0;
}

// ---------------------------------------------------------------------------
// Field validation — fast feedback; the server remains authoritative.
// ---------------------------------------------------------------------------

/**
 * The name is the one required field, and the one the search box matches on, so a
 * record without it cannot be found again. Bounded by `PATIENT_LIMITS.fullName`,
 * the same two figures the route's `isLength` enforces.
 */
export function validatePatientName(fullName: string): string | null {
  const trimmed = fullName.trim();
  if (trimmed.length < PATIENT_LIMITS.fullName.min) {
    return "Enter the patient's full name";
  }
  if (trimmed.length > PATIENT_LIMITS.fullName.max) {
    return `That name is too long — ${PATIENT_LIMITS.fullName.max} characters at most`;
  }
  return null;
}

/**
 * A phone is bounded by length only and may be absent, for the reason
 * `staff.routes.ts` and `patients.routes.ts` both give: a format rule that rejects
 * a Ghanaian number the pharmacist knows is correct teaches them to type a false
 * one. What the number decides is whether a reminder can be texted, and the record
 * reports that as `smsNumber` rather than refusing the record.
 */
export function validatePatientPhone(phone: string): string | null {
  if (phone.trim().length > PATIENT_LIMITS.phone.max) {
    return `That phone number is too long — ${PATIENT_LIMITS.phone.max} characters at most`;
  }
  return null;
}

/**
 * An optional date of birth, checked as a real calendar day.
 *
 * `daysSinceEpoch` refuses an impossible date — 2026-02-30 — by the same round trip
 * the expiry logic uses, rather than leaving the server's `strictMode` check to be
 * the first to say so. A future date is not refused here: the server does not
 * refuse one either, and this module stays no stricter than the contract it is
 * giving feedback on.
 */
export function validateDateOfBirth(dateOfBirth: string): string | null {
  const trimmed = dateOfBirth.trim();
  if (trimmed === '') return null;
  if (daysSinceEpoch(trimmed) === null) {
    return 'Enter the date of birth as YYYY-MM-DD';
  }
  return null;
}

/** Notes are optional and bounded by `PATIENT_LIMITS.notes.max`. */
export function validatePatientNotes(notes: string): string | null {
  if (notes.trim().length > PATIENT_LIMITS.notes.max) {
    return `Notes must be ${PATIENT_LIMITS.notes.max} characters or fewer`;
  }
  return null;
}

/**
 * One clinical list, checked the two ways the route checks it: how many entries,
 * and how long each one is. `label` is the plural the operator sees — "allergies",
 * "conditions", "medications" — so both messages read as sentences about the field
 * they sit beside rather than about a column.
 */
export function validateClinicalList(text: string, label: string): string | null {
  const entries = parseClinicalList(text);
  if (entries.length > PATIENT_LIMITS.listLength.max) {
    return `Enter ${label} as ${PATIENT_LIMITS.listLength.max} entries or fewer`;
  }
  if (entries.some((entry) => entry.length > PATIENT_LIMITS.listItem.max)) {
    return `Each ${label} entry must be ${PATIENT_LIMITS.listItem.max} characters or fewer`;
  }
  return null;
}
