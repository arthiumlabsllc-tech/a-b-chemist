import type { Sql } from '../database/pool';
import { normaliseGhanaPhone } from '../utils/phone';
import type { Gender } from '../utils/schema-enums';
import { likePattern } from './inventory.repository';

/**
 * The patients table, and nothing else.
 *
 * ## Why the update preserves columns it was not asked about
 *
 * `updatePatient` is one statement with a fixed shape, and four of its
 * parameters are booleans that say whether a column was supplied at all. That
 * looks like a lot of machinery for an edit form, and it is there because of a
 * specific failure:
 *
 * A patch built the obvious way — read the row, spread the edit over it, write
 * the whole row back — loses whatever somebody else changed in between. Two
 * members of staff with the same patient open, one adding an allergy and one
 * adding a note, and the second save writes back the row it read, which has no
 * allergy in it. Nothing errors. The allergy is gone and the record still says
 * it was updated a minute ago.
 *
 * The alternative used elsewhere in this codebase — `users.repository.ts`'s
 * `updateStaff`, which splices a `set` clause together from whichever fields
 * arrived — is safe against that, but it produces a different statement per
 * combination of fields. Eight optional columns is 256 shapes, and the Postgres
 * harness would need a PREPARE for each to prove them. Two of those shapes are
 * in section 9a and that is already two PREPAREs for four fields.
 *
 * So: one shape, and the columns nobody mentioned are left alone by the
 * statement rather than by the caller's timing.
 *
 * The four booleans exist only for the columns that are genuinely nullable —
 * `phone`, `date_of_birth`, `gender`, `notes` — because `coalesce` cannot tell
 * "not supplied" from "cleared". The other four cannot be null in the schema
 * (`full_name` is `not null`, the three arrays are `not null default '{}'`), so
 * for them `coalesce` alone is exact and a flag would be decoration.
 *
 * `updated_at` is not set here. `patients_set_updated_at` does it, and section 5
 * of the harness proves the trigger stamps without swallowing the write.
 *
 * ## Why there is no delete
 *
 * Checked against `init.sql` rather than assumed: `screenings`, `consultations`
 * and `reminders` all reference `patients` with `on delete cascade`, but
 * `prescriptions.patient_id` references it with **no** `on delete` clause at
 * all, which defaults to `NO ACTION`. So deleting a patient who has ever had a
 * prescription fails with a foreign-key violation, and deleting one who has not
 * succeeds and takes their screening history with it.
 *
 * That is not a bug to route around, and it is not worth exposing an endpoint
 * whose outcome depends on which tables happen to reference the row. A patient
 * record is the history that makes the next dispensing safe: the allergies on it
 * are the reason a pharmacist can hand over a medicine without asking the same
 * three questions again. A record typed in error is edited, not removed, and
 * section 14 of the harness asserts both halves of that behaviour so the
 * reasoning stays tied to what the schema actually does.
 */

const PATIENT_COLUMNS = `id, pharmacy_id, full_name, phone, date_of_birth, gender,
  allergies, conditions, medications, notes, created_at, updated_at`;

/**
 * The search rule, spelled once and shared by the list and the count so the two
 * cannot disagree about how many rows there are.
 *
 * `$2` is the name pattern and `$3` the phone pattern. `$3` is null exactly when
 * the term held no digits, and `like null` is null rather than false — which a
 * `where` treats the same way, so the branch contributes nothing and the name
 * branch decides the row on its own. There is deliberately no `is not null`
 * guard around it: `false or null` and `false or false` exclude the same rows,
 * so a guard would be two extra lines of three-valued logic for a reader to
 * reason about and no change in the answer. `searchPatterns` is what keeps the
 * two parameters in step, and 14e of the harness pins the behaviour from the
 * other side — that a name-only search returns the patients whose name matched
 * and not every patient in the book.
 *
 * `regexp_replace(..., '[^0-9+]', '', 'g')` rather than a list of formatting
 * characters to strip: `utils/phone.ts` keeps its own such list (`FORMATTING`)
 * and a second one here would be two lists that have to agree. "Everything that
 * is not a digit or a plus survives as nothing" is one rule with no counterpart
 * to drift from, because `phoneSearchDigits` below reduces the search term by
 * the same rule.
 *
 * `ilike` on `full_name` is a sequential scan. At one pharmacy's patient count
 * that is a few thousand rows and the alternative — `pg_trgm` and a GIN index —
 * is an extension to install and keep installed for a search box that is used a
 * dozen times a shift.
 */
const SEARCH = `($2::text is null
        or full_name ilike $2
        or regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') like $3)`;

export interface PatientRow {
  id: string;
  pharmacyId: string;
  fullName: string;
  /**
   * Stored exactly as it was typed and displayed exactly as it was stored. See
   * `utils/phone.ts` for why nothing normalises this on the way in or formats it
   * on the way out.
   */
  phone: string | null;
  /**
   * `YYYY-MM-DD`. `database/pg-types.ts` overrides the `date` parser so this
   * arrives as the string it came over the wire as rather than a JS `Date` at
   * local midnight, which would move the day on any host east of UTC.
   */
  dateOfBirth: string | null;
  /**
   * Null means the question was never asked; `'undisclosed'` means it was asked
   * and declined. Two facts a pharmacist reading back a record wants apart.
   */
  gender: Gender | null;
  allergies: string[];
  conditions: string[];
  medications: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewPatient {
  pharmacyId: string;
  fullName: string;
  phone: string | null;
  dateOfBirth: string | null;
  gender: Gender | null;
  allergies: readonly string[];
  conditions: readonly string[];
  medications: readonly string[];
  notes: string | null;
}

/**
 * Every field optional, and `undefined` means "leave it alone" while `null`
 * means "clear it". The distinction is what the four boolean parameters in
 * `updatePatient` carry into the statement.
 */
export interface PatientPatch {
  fullName?: string;
  phone?: string | null;
  dateOfBirth?: string | null;
  gender?: Gender | null;
  allergies?: readonly string[];
  conditions?: readonly string[];
  medications?: readonly string[];
  notes?: string | null;
}

export interface PatientFilters {
  /**
   * One term searched against the name and the phone number, because that is
   * what somebody at the counter has: either the patient told them who they are
   * or they read out a number. Omitted, null or empty means every patient.
   */
  search?: string | null;
  limit: number;
  offset: number;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A Postgres `text[]` arrives as a JS array, and it can hold NULL elements —
 * `'{ aspirin, NULL }` is a legal value for the column. Those are dropped
 * rather than coerced: `String(null)` is `'null'`, which would put a four-letter
 * allergy on a patient's record that nobody typed and no pharmacist would
 * recognise as absent. A NULL element carries no information, so nothing is lost
 * by not rendering it.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function mapPatient(row: Record<string, unknown>): PatientRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    fullName: row.full_name as string,
    phone: textOrNull(row.phone),
    dateOfBirth: textOrNull(row.date_of_birth),
    gender: (row.gender as Gender | null) ?? null,
    allergies: toStringArray(row.allergies),
    conditions: toStringArray(row.conditions),
    medications: toStringArray(row.medications),
    notes: textOrNull(row.notes),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Reduces a search term to the digits worth comparing a phone number by.
 *
 * `utils/phone.ts` is explicit that `patients.phone` is stored exactly as it was
 * typed, and the same handset gets written down five ways in a week:
 * `024 123 4567`, `0241234567`, `+233241234567`, `233241234567`, `24 123 4567`.
 * A `like` against the raw column finds whichever of those the search term
 * happens to be written as and misses the rest, so both sides are reduced first.
 *
 * The nine national digits are the part every written form of the same Ghana
 * number has in common, and dropping the trunk `0` and the `233` is what makes
 * `0241234567` and `+233241234567` the same search. `normaliseGhanaPhone` does
 * that reduction when it can.
 *
 * When it cannot — a partial fragment like `024 123`, or a number that is not
 * Ghanaian at all — the leading zeros come off the digits typed and the rest is
 * used as it stands. Refusing to search in that case would be the `phone.ts`
 * mistake in reverse: the normaliser's job is to decide whether a *destination*
 * is sendable, and a search term is not a destination. A customer visiting from
 * Lomé has a Togolese number on their record and a pharmacist who types it into
 * the search box should find them.
 *
 * The zeros come off the fragment too, and not only off the complete numbers
 * `normaliseGhanaPhone` handles, because a fragment is what somebody types when
 * they half-remember a number — and half-remembered numbers are half-remembered
 * in the local form, with the trunk `0` on the front. Without this a search for
 * `024 123` finds the customers whose number was written locally and silently
 * misses the ones written internationally, which is a search whose results depend
 * on who was at the counter on the day each record was typed.
 *
 * Null means nothing survived to compare a phone number by — a term with no
 * digits, or one that was only zeros — so the caller leaves the phone branch out
 * and the name decides. Sending `%%` instead would match every patient with a
 * phone and turn a name search into the whole book.
 */
export function phoneSearchDigits(term: string): string | null {
  const digits = term.replace(/\D/g, '');
  const normalised = normaliseGhanaPhone(digits);
  const significant =
    normalised === null ? digits.replace(/^0+/, '') : normalised.slice(-9);
  return significant === '' ? null : significant;
}

/**
 * Builds the two `like` patterns one search term produces.
 *
 * Split out from `listPatients` and `countPatients` rather than written twice,
 * because a list and a count that disagree about what a search means produce a
 * page of results with a total that does not match it — and the way that shows
 * up is a pager offering a next page that is empty.
 */
function searchPatterns(search: string | null | undefined): {
  name: string | null;
  phone: string | null;
} {
  const term = search === undefined || search === null ? '' : search.trim();
  if (term === '') return { name: null, phone: null };

  const digits = phoneSearchDigits(term);
  return {
    // `likePattern` escapes `\`, `%` and `_`, so a term containing them searches
    // for them instead of changing what the search means. Without it a patient
    // named `A_` would match every patient whose name starts with A.
    name: likePattern(term),
    // The phone pattern needs no escaping, and that is a property of how it was
    // built rather than an oversight: `phoneSearchDigits` keeps only `0-9`, so
    // there is no `%`, `_` or `\` in it to escape. Escaping it anyway would be
    // correct and would also be a line that reads as though a phone number could
    // contain a wildcard.
    phone: digits === null ? null : `%${digits}%`,
  };
}

export async function createPatient(sql: Sql, input: NewPatient): Promise<PatientRow> {
  const result = await sql.query(
    `insert into patients
       (pharmacy_id, full_name, phone, date_of_birth, gender, allergies, conditions,
        medications, notes)
     values ($1, $2, $3, $4::date, $5::gender, $6::text[], $7::text[], $8::text[],
             $9)
     returning ${PATIENT_COLUMNS}`,
    [
      input.pharmacyId,
      input.fullName,
      input.phone,
      input.dateOfBirth,
      input.gender,
      [...input.allergies],
      [...input.conditions],
      [...input.medications],
      input.notes,
    ]
  );
  const inserted = result.rows[0];
  if (inserted === undefined) {
    // INSERT ... RETURNING always yields the row it inserted. There is no unique
    // index on this table for a conflict to swallow it, so an empty result here
    // means something is wrong with the statement rather than with the input.
    throw new Error('insert into patients returned no row');
  }
  return mapPatient(inserted);
}

/**
 * One patient, or null if this pharmacy has no such patient.
 *
 * `pharmacy_id` is in the predicate rather than checked afterwards. Filtering
 * after the read would return the row to the caller first and rely on the caller
 * noticing whose it is, which is the shape of bug that only shows up once there
 * is a second tenant — and this schema is single-tenant precisely so that day
 * cannot arrive quietly.
 */
export async function findPatient(
  sql: Sql,
  pharmacyId: string,
  patientId: string
): Promise<PatientRow | null> {
  const result = await sql.query(
    `select ${PATIENT_COLUMNS} from patients
      where pharmacy_id = $1 and id = $2`,
    [pharmacyId, patientId]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapPatient(first);
}

export async function listPatients(
  sql: Sql,
  pharmacyId: string,
  filters: PatientFilters
): Promise<PatientRow[]> {
  const patterns = searchPatterns(filters.search);
  const result = await sql.query(
    `select ${PATIENT_COLUMNS} from patients
      where pharmacy_id = $1
        and ${SEARCH}
      order by full_name, id
      limit $4 offset $5`,
    [pharmacyId, patterns.name, patterns.phone, filters.limit, filters.offset]
  );
  return result.rows.map(mapPatient);
}

/**
 * How many patients match the same search, for the pager's total.
 *
 * Counted in its own statement rather than derived from a page: a caller paging
 * through twenty would otherwise see a total that changed as they paged.
 */
export async function countPatients(
  sql: Sql,
  pharmacyId: string,
  filters: Omit<PatientFilters, 'limit' | 'offset'>
): Promise<number> {
  const patterns = searchPatterns(filters.search);
  const result = await sql.query(
    `select count(*)::int as n from patients
      where pharmacy_id = $1
        and ${SEARCH}`,
    [pharmacyId, patterns.name, patterns.phone]
  );
  const first = result.rows[0];
  // `count(*)::int` because pg hands a `bigint` back as a string, and `'0' === 0`
  // is false — an empty patient list would read as a non-empty one to any caller
  // comparing the total against zero.
  return first === undefined ? 0 : (first.n as number);
}

/**
 * Applies an edit, leaving alone every column the patch did not mention.
 *
 * Returns null when this pharmacy has no such patient, which is also what a
 * caller uses to answer 404 — the statement's `pharmacy_id` predicate is what
 * makes another tenant's patient indistinguishable from a patient who does not
 * exist, and that is the point.
 */
export async function updatePatient(
  sql: Sql,
  pharmacyId: string,
  patientId: string,
  patch: PatientPatch
): Promise<PatientRow | null> {
  const result = await sql.query(
    `update patients
        set full_name = coalesce($3::text, full_name),
            allergies = coalesce($4::text[], allergies),
            conditions = coalesce($5::text[], conditions),
            medications = coalesce($6::text[], medications),
            phone = case when $7::boolean then $8::text else phone end,
            date_of_birth = case when $9::boolean then $10::date
                                 else date_of_birth end,
            gender = case when $11::boolean then $12::gender else gender end,
            notes = case when $13::boolean then $14::text else notes end
      where pharmacy_id = $1 and id = $2
      returning ${PATIENT_COLUMNS}`,
    [
      pharmacyId,
      patientId,
      patch.fullName ?? null,
      patch.allergies === undefined ? null : [...patch.allergies],
      patch.conditions === undefined ? null : [...patch.conditions],
      patch.medications === undefined ? null : [...patch.medications],
      patch.phone !== undefined,
      patch.phone ?? null,
      patch.dateOfBirth !== undefined,
      patch.dateOfBirth ?? null,
      patch.gender !== undefined,
      patch.gender ?? null,
      patch.notes !== undefined,
      patch.notes ?? null,
    ]
  );
  const updated = result.rows[0];
  return updated === undefined ? null : mapPatient(updated);
}
