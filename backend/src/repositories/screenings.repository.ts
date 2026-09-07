import type { Sql } from '../database/pool';
import {
  classifyRisk,
  toNumberOrNull,
  type ScreeningMeasurement,
} from '../utils/screening';
import type { RiskLevel, ScreeningType } from '../utils/schema-enums';

/**
 * The screenings table, and nothing else.
 *
 * ## There is no update, and that is the table rather than an omission
 *
 * `screenings` has `created_at` and no `updated_at`, and no `set_updated_at`
 * trigger — it is the only table in the schema with neither. A screening is a
 * measurement that was taken at a moment by a person, and editing one would make
 * the record say something happened that did not. A reading taken twice is two
 * rows; a reading taken wrongly is a new row beside it, with the notes to say so.
 *
 * So this module writes and reads and does not offer a way to change a row. If
 * an update is ever added, the trigger has to come with it, and section 5 of the
 * harness is what would prove it stamps the column.
 *
 * ## Why `riskLevel` is not an input
 *
 * `NewScreening` carries a `ScreeningMeasurement` — the discriminated union from
 * `utils/screening.ts` — and no risk level. The level is derived here, on the way
 * in, by `classifyRisk`. That is a structural guarantee rather than a convention:
 * there is no parameter a caller could pass a level through, so a client posting
 * `riskLevel: 'low'` beside a systolic of 210 has nowhere to put it.
 *
 * The union buys the same thing for the measurements. A `blood_pressure` member
 * carries both of its numbers, so a row claiming a blood pressure was taken with
 * only one number in it cannot be constructed — which matters because that is the
 * one kind of empty record a clinician cannot afford.
 *
 * ## Why the reason is stored nowhere
 *
 * `classifyRisk` answers a level *and* a sentence, and only the level is written.
 * The sentence is a pure function of the stored measurements, so a reader can
 * re-derive it exactly, and storing it would create a row able to disagree with
 * the module that produced it the first time a threshold was corrected.
 *
 * The asymmetry is deliberate and worth stating, because it looks like an
 * oversight: the **level** is the decision made at the time and is kept as it was
 * made, so correcting a threshold does not quietly re-triage a year of patients;
 * the **sentence** is help text and is rebuilt on every read, so correcting a
 * threshold improves the explanation beside every historical row without moving
 * any of them.
 */

const SCREENING_COLUMNS = `id, pharmacy_id, patient_id, recorded_by, type,
  risk_level, systolic_bp, diastolic_bp, blood_glucose_mmol, weight_kg,
  height_cm, bmi, temperature_c, heart_rate_bpm, measured_at, notes, created_at`;

/**
 * The list's filter rule, spelled once.
 *
 * One statement with nullable parameters rather than a `where` spliced together
 * per combination, for the reason `notifications.repository.ts` records: the
 * placeholder count stops depending on the caller's input, so the harness needs
 * one PREPARE instead of one per shape, and a combination no test happened to
 * exercise is still a statement somebody parsed against the real schema.
 *
 * `to` is widened to the whole day by adding one and comparing with `<`, which is
 * what `sales.repository.ts` does for the same two words on a receipt list. A
 * closing bound of `<= $5::date` would mean "up to midnight at the start of the
 * day", so a chart asked for March would silently drop every reading taken in
 * March.
 */
const FILTERS = `($2::uuid is null or patient_id = $2::uuid)
        and ($3::screening_type[] is null or type = any($3::screening_type[]))
        and ($4::date is null or measured_at >= $4::date)
        and ($5::date is null or measured_at < $5::date + interval '1 day')`;

export interface ScreeningRow {
  id: string;
  pharmacyId: string;
  patientId: string;
  /** Never null: the column is `not null`, because a reading nobody took is not a reading. */
  recordedBy: string;
  type: ScreeningType;
  /**
   * The level as it was decided when the row was written. Re-deriving it on read
   * would make a corrected threshold retroactively re-triage every patient the
   * pharmacy has ever screened.
   */
  riskLevel: RiskLevel;
  systolicBp: number | null;
  diastolicBp: number | null;
  bloodGlucoseMmol: number | null;
  weightKg: number | null;
  /**
   * Recorded but never classified. `utils/screening.ts` has no threshold on
   * centimetres and a height on its own is not a risk reading; it is here because
   * a BMI without the height it came from cannot be checked by anybody reading
   * the record later.
   */
  heightCm: number | null;
  bmi: number | null;
  temperatureC: number | null;
  heartRateBpm: number | null;
  measuredAt: string;
  notes: string | null;
  /** And no `updatedAt`, for the reason at the top of this file. */
  createdAt: string;
}

export interface NewScreening {
  pharmacyId: string;
  patientId: string;
  recordedBy: string;
  measurement: ScreeningMeasurement;
  /**
   * Measurements taken at the same visit that are not the one being classified.
   *
   * Recorded on any type rather than only beside a BMI, because a visit that
   * weighed somebody and took their blood pressure should not have the weight
   * thrown away on the grounds that the pharmacist called it a blood pressure
   * screening. `classifyRisk` still classifies only the named measurement, which
   * is the honest limit of what one row can support.
   */
  weightKg?: number | null;
  heightCm?: number | null;
  measuredAt: string;
  notes: string | null;
}

export interface ScreeningFilters {
  /** One patient's history. Omitted or null means the whole pharmacy. */
  patientId?: string | null;
  /**
   * Restrict to these types. Omitted or empty means every type, and empty is
   * folded into "every type" here rather than sent as an empty array: `type =
   * any('{}')` is valid SQL matching no row, so a chart asked for nothing would
   * draw nothing and look like a patient with no history.
   */
  types?: readonly ScreeningType[];
  /** `YYYY-MM-DD`, inclusive. */
  from?: string | null;
  /** `YYYY-MM-DD`, inclusive of the whole day. */
  to?: string | null;
  limit: number;
  offset: number;
}

interface MeasurementColumns {
  systolicBp: number | null;
  diastolicBp: number | null;
  bloodGlucoseMmol: number | null;
  weightKg: number | null;
  heightCm: number | null;
  bmi: number | null;
  temperatureC: number | null;
  heartRateBpm: number | null;
}

/**
 * Spreads one member of the union back over the eight nullable columns.
 *
 * The inverse of `measurementFrom`, which does the same job in the other
 * direction out of a row. The two are in different modules on purpose — that one
 * validates a request and this one writes a row — but both switch on the same
 * union, and both are exhaustive by their declared return type: a seventh member
 * of `screening_type` makes each of them fall through and `tsc` refuse the file,
 * because the end of the function becomes reachable and the return type does not
 * include `undefined`.
 */
function measurementColumns(
  measurement: ScreeningMeasurement,
  extras: { weightKg?: number | null; heightCm?: number | null }
): MeasurementColumns {
  const columns: MeasurementColumns = {
    systolicBp: null,
    diastolicBp: null,
    bloodGlucoseMmol: null,
    weightKg: extras.weightKg ?? null,
    heightCm: extras.heightCm ?? null,
    bmi: null,
    temperatureC: null,
    heartRateBpm: null,
  };

  switch (measurement.type) {
    case 'blood_pressure':
      columns.systolicBp = measurement.systolic;
      columns.diastolicBp = measurement.diastolic;
      return columns;
    case 'blood_sugar':
      columns.bloodGlucoseMmol = measurement.glucoseMmol;
      return columns;
    case 'bmi':
      columns.bmi = measurement.bmi;
      return columns;
    case 'weight':
      // The measurement wins over the extra. Both are a weight in kilograms and
      // the one in the union is the one that was classified, so storing the other
      // would leave a row whose level was decided from a number it does not show.
      columns.weightKg = measurement.weightKg;
      return columns;
    case 'temperature':
      columns.temperatureC = measurement.temperatureC;
      return columns;
    case 'heart_rate':
      columns.heartRateBpm = measurement.heartRateBpm;
      return columns;
  }
}

/**
 * `numeric` columns arrive as decimal text and `integer` columns as numbers, so
 * both have to be accepted. Anything else — null, undefined, or a column list
 * that drifted — is null rather than a `TypeError` from inside a mapper, which
 * would surface as a 500 with no patient and no reading in it.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'string' || typeof value === 'number'
    ? toNumberOrNull(value)
    : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapScreening(row: Record<string, unknown>): ScreeningRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    patientId: row.patient_id as string,
    recordedBy: row.recorded_by as string,
    type: row.type as ScreeningType,
    riskLevel: row.risk_level as RiskLevel,
    systolicBp: numberOrNull(row.systolic_bp),
    diastolicBp: numberOrNull(row.diastolic_bp),
    bloodGlucoseMmol: numberOrNull(row.blood_glucose_mmol),
    weightKg: numberOrNull(row.weight_kg),
    heightCm: numberOrNull(row.height_cm),
    bmi: numberOrNull(row.bmi),
    temperatureC: numberOrNull(row.temperature_c),
    heartRateBpm: numberOrNull(row.heart_rate_bpm),
    measuredAt: (row.measured_at as Date).toISOString(),
    notes: textOrNull(row.notes),
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function createScreening(sql: Sql, input: NewScreening): Promise<ScreeningRow> {
  const assessment = classifyRisk(input.measurement);
  const columns = measurementColumns(input.measurement, input);

  const result = await sql.query(
    `insert into screenings
       (pharmacy_id, patient_id, recorded_by, type, risk_level, systolic_bp,
        diastolic_bp, blood_glucose_mmol, weight_kg, height_cm, bmi, temperature_c,
        heart_rate_bpm, measured_at, notes)
     values ($1, $2, $3, $4::screening_type, $5::risk_level, $6, $7, $8, $9, $10,
             $11, $12, $13, $14::timestamptz, $15)
     returning ${SCREENING_COLUMNS}`,
    [
      input.pharmacyId,
      input.patientId,
      input.recordedBy,
      input.measurement.type,
      assessment.level,
      columns.systolicBp,
      columns.diastolicBp,
      columns.bloodGlucoseMmol,
      columns.weightKg,
      columns.heightCm,
      columns.bmi,
      columns.temperatureC,
      columns.heartRateBpm,
      input.measuredAt,
      input.notes,
    ]
  );
  const inserted = result.rows[0];
  if (inserted === undefined) {
    // INSERT ... RETURNING always yields the row it inserted. Nothing on this
    // table can swallow it: there is no unique index and no ON CONFLICT.
    throw new Error('insert into screenings returned no row');
  }
  return mapScreening(inserted);
}

/**
 * Readings newest first, which is the order a history is read in and the order a
 * chart wants its points in reverse.
 *
 * `id desc` is the tie-break, and it is not decoration: `measured_at` defaults to
 * `now()`, which is transaction-start time, so two readings written in one
 * transaction carry an identical timestamp. Without a tie-break the order of
 * those two is whatever the planner felt like, and a list that reorders itself
 * between two loads of the same page is a list nobody can read carefully.
 */
export async function listScreenings(
  sql: Sql,
  pharmacyId: string,
  filters: ScreeningFilters
): Promise<ScreeningRow[]> {
  const types = filters.types !== undefined && filters.types.length > 0 ? [...filters.types] : null;

  const result = await sql.query(
    `select ${SCREENING_COLUMNS} from screenings
      where pharmacy_id = $1
        and ${FILTERS}
      order by measured_at desc, id desc
      limit $6 offset $7`,
    [
      pharmacyId,
      filters.patientId ?? null,
      types,
      filters.from ?? null,
      filters.to ?? null,
      filters.limit,
      filters.offset,
    ]
  );
  return result.rows.map(mapScreening);
}

/**
 * The most recent reading of one type for one patient, or null if there is none.
 *
 * This is the function that makes a trend possible, and a trend is most of what a
 * counter screening is worth: one blood pressure of 148/92 is a number, and that
 * same number beside a previous 128/82 is a direction. `classifyWeight`'s reason
 * asks for exactly this comparison, because a kilogram figure on its own is not a
 * risk reading and the module says so rather than inventing a level for it.
 *
 * `limit 1` on an ordered read rather than an aggregate, so the whole row comes
 * back and the caller can see when it was taken — "your last reading was high" is
 * a different sentence depending on whether it was last week or last year.
 */
export async function latestScreeningOfType(
  sql: Sql,
  pharmacyId: string,
  patientId: string,
  type: ScreeningType
): Promise<ScreeningRow | null> {
  const result = await sql.query(
    `select ${SCREENING_COLUMNS} from screenings
      where pharmacy_id = $1
        and patient_id = $2
        and type = $3::screening_type
      order by measured_at desc, id desc
      limit 1`,
    [pharmacyId, patientId, type]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapScreening(first);
}
