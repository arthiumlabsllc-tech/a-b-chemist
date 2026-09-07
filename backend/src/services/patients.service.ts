import { poolSql, withTransaction } from '../database/pool';
import {
  countPatients,
  createPatient,
  findPatient,
  listPatients,
  updatePatient,
  type PatientFilters,
  type PatientPatch,
  type PatientRow,
} from '../repositories/patients.repository';
import type { Actor } from './inventory.service';
import { todayDateOnly } from '../utils/clock';
import { HttpError, notFound } from '../utils/http';
import { normaliseGhanaPhone } from '../utils/phone';

/**
 * Patient records: the four lists, the two contact fields, and no identifier
 * from any national scheme.
 *
 * ## What is not here
 *
 * There is no field for a national health insurance number, and no place to put
 * one. That is not an omission to be filled in later: `database/init.sql` authors
 * the `patients` table without the column, and Postgres cannot remove an enum
 * value once created, so a scheme that arrived in the schema would be there for
 * the life of the database whether or not anything used it. The absence is proven
 * at the schema level by section 7 of `database/tests/assertions.sql` and in the
 * source text by `npm run guard:terms`.
 *
 * There is also no delete. A patient is named by `sales.patient_id`, by every
 * screening and consultation, and by every prescription; deleting one would either
 * orphan the record of what was dispensed to whom or cascade it away. Reminders do
 * go with their patient — `reminders.patient_id` is `on delete cascade` — but that
 * is the schema's answer to a row that disappears some other way, not a route.
 *
 * ## The phone number is stored as typed and judged separately
 *
 * Nothing here normalises, reformats or refuses a number. A rule that rejects a
 * Ghanaian number the pharmacist knows is correct teaches them to type something
 * false, and a false number is worse than an oddly formatted one — the reasoning
 * `staff.routes.ts` records for the same field on a staff member.
 *
 * What the number does decide is whether a reminder can be texted, and that is
 * reported rather than enforced: `smsNumber` on the view is `normaliseGhanaPhone`'s
 * answer, so a record whose number cannot be sent to says so on the patient page
 * instead of saying so three weeks later as a reminder that was not sent. The
 * refusal itself stays where it belongs, in `services/sms.ts`, which has its own
 * sentence for a number it cannot use.
 */

/**
 * The lengths the routes validate against, kept beside the reasoning.
 *
 * None of these columns is length-limited in the schema, so this is the only thing
 * standing between a pasted document and a record that takes a second to render.
 * `fullName` and `phone` match what `staff.routes.ts` uses for the same two fields
 * on a member of staff: a name is a name whichever table it is in, and two different
 * ceilings for one kind of value is a difference nobody would be able to explain.
 */
export const PATIENT_LIMITS = {
  fullName: { min: 2, max: 120 },
  phone: { min: 0, max: 32 },
  notes: { min: 0, max: 2000 },
  /** One entry in allergies, conditions or medications — a medicine or substance name. */
  listItem: { min: 1, max: 200 },
  /** How many entries one of the three lists may hold. */
  listLength: { min: 0, max: 100 },
} as const;

/**
 * One patient, as the API returns it.
 *
 * Exported because it is the contract rather than a local helper type:
 * `frontend/src/lib/api-types.ts` copies it and `api-types.mirror.test.ts` reads
 * this declaration to hold the two together.
 */
export interface PatientView extends PatientRow {
  /**
   * The number in the form an SMS provider would be given, or null when there is
   * no number on the record or the one there cannot be sent to.
   *
   * Null is not an error and does not stop anything being recorded. It means the
   * reminders for this patient will be raised as `not sent` with a reason beside
   * them, which is exactly what `services/sms.ts` does — the difference is that
   * here the pharmacist can see it while the patient is still at the counter.
   */
  smsNumber: string | null;
}

/** What the record form posts. Every field except the name is optional. */
export interface PatientInput {
  fullName: string;
  phone?: string | null;
  /** `YYYY-MM-DD`, or null for a patient who does not know it. */
  dateOfBirth?: string | null;
  gender?: PatientRow['gender'];
  allergies?: readonly string[];
  conditions?: readonly string[];
  medications?: readonly string[];
  notes?: string | null;
}

export interface PatientPage {
  patients: PatientView[];
  /**
   * Every patient matching the search, not just the page of them.
   *
   * Counted with `countPatients`, which shares `listPatients`' two search
   * patterns for precisely this reason: a pager total that does not match the
   * page it is beside is worse than no total at all, because it is believed.
   */
  total: number;
  limit: number;
  offset: number;
}

function toView(row: PatientRow): PatientView {
  return { ...row, smsNumber: normaliseGhanaPhone(row.phone) };
}

/**
 * One of the three lists, as it should be stored.
 *
 * Trimmed, emptied out and de-duplicated. A form with a blank row in it would
 * otherwise store an empty string, and an allergy list carrying `''` is a list a
 * pharmacist has to read past to find the allergies — on the one record in the
 * system where skimming has consequences.
 *
 * Duplicates are dropped only when the trimmed strings are identical. Two
 * spellings that differ in case are kept, because to the person who typed them
 * they may be two different things, and an allergy list that quietly merged what
 * a pharmacist wrote is a list that no longer says what they said.
 *
 * Order is preserved rather than sorted: the first entry is usually the one that
 * matters most to whoever typed it, and re-sorting an allergy list alphabetically
 * puts "Aspirin" above "Penicillin" in a country where neither is the reason the
 * list was written.
 */
export function tidyList(values: readonly string[] | undefined | null): string[] {
  if (values === undefined || values === null) return [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }
  return kept;
}

/**
 * A date of birth that cannot be in the future.
 *
 * Checked here rather than at the route because it is a relationship with the clock
 * and express-validator has no "not after today" that also knows which day it is —
 * the split `reports.routes.ts` records, where the route owns the format and the
 * service owns the meaning.
 *
 * A forward-dated birth date is not a harmless typo. Every screen that shows an age
 * derives it from this column, so one wrong keystroke produces a negative age on a
 * record a pharmacist is reading while deciding a dose — and the number looks like
 * a number, not like a mistake. Null is left alone: a patient who does not know when
 * they were born has no date, and that is a fact rather than a gap to fill in.
 */
function dateOfBirthFrom(value: string | null | undefined, today: string): string | null {
  if (value === undefined || value === null) return null;
  if (value > today) {
    // Compared as text rather than parsed. `YYYY-MM-DD` sorts the same way it
    // compares, and a comparison that cannot fail to parse is one that cannot
    // quietly let a malformed value through as "not in the future".
    throw new HttpError(400, 'The date of birth cannot be in the future', {
      code: 'validation_failed',
      details: [{ field: 'dateOfBirth', message: 'Enter a date that has already happened' }],
    });
  }
  return value;
}

/**
 * The patch shape `updatePatient` expects, built field by field.
 *
 * Not spread from the body. `undefined` means "leave it alone" and `null` means
 * "clear it", and a spread would carry an unknown key posted by a stale frontend
 * straight into the statement's parameter list. Building it field by field is what
 * makes that distinction survive contact with a request body.
 */
function patchFrom(input: PatientInput, today: string): PatientPatch {
  return {
    ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
    ...(input.phone === undefined ? {} : { phone: input.phone }),
    ...(input.dateOfBirth === undefined
      ? {}
      : { dateOfBirth: dateOfBirthFrom(input.dateOfBirth, today) }),
    ...(input.gender === undefined ? {} : { gender: input.gender }),
    ...(input.allergies === undefined ? {} : { allergies: tidyList(input.allergies) }),
    ...(input.conditions === undefined ? {} : { conditions: tidyList(input.conditions) }),
    ...(input.medications === undefined ? {} : { medications: tidyList(input.medications) }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

/** `patients:write`. */
export async function registerPatient(
  actor: Actor,
  input: PatientInput
): Promise<PatientView> {
  const row = await createPatient(poolSql, {
    pharmacyId: actor.pharmacyId,
    fullName: input.fullName,
    phone: input.phone ?? null,
    dateOfBirth: dateOfBirthFrom(input.dateOfBirth, todayDateOnly()),
    gender: input.gender ?? null,
    allergies: tidyList(input.allergies),
    conditions: tidyList(input.conditions),
    medications: tidyList(input.medications),
    notes: input.notes ?? null,
  });
  return toView(row);
}

/** `patients:read`. */
export async function getPatient(
  pharmacyId: string,
  patientId: string
): Promise<PatientView> {
  const row = await findPatient(poolSql, pharmacyId, patientId);
  // A miss and another pharmacy's patient both answer 404 with the same words, for
  // the reason `utils/http.ts` records: telling them apart is a way to enumerate
  // which ids exist elsewhere.
  if (row === null) throw notFound('patient');
  return toView(row);
}

/** `patients:read`. */
export async function listPatientPage(
  pharmacyId: string,
  filters: PatientFilters
): Promise<PatientPage> {
  // Both reads outside a transaction and both against the same filters. A serialisable
  // transaction would make the pair exact, but the cost is a lock held across two
  // queries to serve a search box, and the inaccuracy it buys is a total that is
  // one registration out for the milliseconds between the two — which is also what
  // the page would show a moment later on refresh.
  const [patients, total] = await Promise.all([
    listPatients(poolSql, pharmacyId, filters),
    countPatients(poolSql, pharmacyId, { search: filters.search }),
  ]);
  return {
    patients: patients.map(toView),
    total,
    limit: filters.limit,
    offset: filters.offset,
  };
}

/**
 * `patients:write`.
 *
 * The record is looked up first and inside the same transaction as the update, so
 * a null coming back from `updatePatient` means the row went between the two —
 * which, with no delete route, is a concurrent edit against a patient another
 * session removed by hand. Without the lookup the two cases are indistinguishable
 * and the honest 404 becomes a guess.
 */
export async function changePatient(
  actor: Actor,
  patientId: string,
  input: PatientInput
): Promise<PatientView> {
  const patch = patchFrom(input, todayDateOnly());
  if (Object.keys(patch).length === 0) {
    // Reported rather than answered with an unchanged row. A silent no-op is a
    // frontend that believes it saved something it did not send.
    throw new HttpError(400, 'Nothing to change — send at least one field to edit', {
      code: 'nothing_to_update',
    });
  }

  const row = await withTransaction(async (client) => {
    const existing = await findPatient(client, actor.pharmacyId, patientId);
    if (existing === null) throw notFound('patient');

    return updatePatient(client, actor.pharmacyId, patientId, patch);
  });

  if (row === null) throw notFound('patient');
  return toView(row);
}
