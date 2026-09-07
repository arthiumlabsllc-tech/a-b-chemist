import type { Sql } from '../database/pool';
import type { PrescriptionStatus } from '../utils/schema-enums';

/**
 * The prescriptions table: the authority behind a dispensing.
 *
 * ## Why there is no delete
 *
 * Three reasons, and they are independent of each other.
 *
 * `patient_id uuid references patients (id)` carries no `on delete` clause, so it
 * restricts — which is the fact section 14h executes and the reason
 * `patients.repository.ts` offers no delete either. The two modules are honest
 * about the same constraint from opposite ends of it.
 *
 * `approved_by uuid references users (id)` restricts the same way, so a
 * prescription cannot be removed by removing the pharmacist who approved it.
 *
 * The reason that would matter even without either foreign key is what a
 * prescription *is*: the record that a specific medicine was supplied to a
 * specific person under a named prescriber's authority. `sale_id` is
 * `on delete set null`, so the prescription deliberately survives its sale — a
 * receipt can be voided and the fact that medicine left the shelf cannot go with
 * it, because then the stock ledger would show a movement nothing authorises. A
 * delete here would remove the only link between a sale line and the authority to
 * sell it, and section 17 asserts the survival rather than trusting the clause.
 *
 * ## Status moves in one direction, with `rejected` as the only exit
 *
 * `pending` to `approved` to `dispensed`, and any of the first two to `rejected`.
 * Nothing leaves `dispensed`: it is a fact about medicine that has left the shelf,
 * so a dispensing that was wrong is corrected on the stock ledger with a write-off
 * and on the sale with a refund, not by putting the prescription back to `pending`
 * and losing the record that it was ever supplied.
 *
 * The repository does not encode that rule. It takes the states a transition may
 * start from as a parameter, exactly as `updateSalePaymentStatus` and
 * `updateConsultation` do, because which transitions are sound is a decision for
 * the service that has to write the sentence explaining a refusal. What the
 * repository guarantees is the shape: one statement, one guard, and a guard that
 * reads the pre-update status so a transition is a transition rather than a
 * contradiction.
 *
 * ## Why `status` is not an input to a new prescription
 *
 * The insert names six columns and `status` is not one of them, so a new
 * prescription takes the column default. There is no parameter through which a
 * prescription could arrive already dispensed, which is the one status that would
 * be worth forging: it is the one that says medicine left the shelf. Section 17
 * proves the default really is `pending` rather than assuming it from `init.sql`.
 */

const PRESCRIPTION_COLUMNS = `id, pharmacy_id, patient_id, sale_id, prescriber_name,
  status, approved_by, notes, created_at, updated_at`;

/**
 * The filter rule, spelled once and shared by both orderings *and* by the count.
 *
 * Three statements, one definition of "matches", because a badge reading 3 above a
 * list of two rows is the kind of disagreement somebody notices immediately and
 * then stops trusting either number. A second copy of this predicate for the count
 * would be a way for them to drift.
 *
 * One statement per ordering with nullable parameters rather than a `where`
 * spliced together per combination, for the reason `notifications.repository.ts`
 * records: the placeholder count stops depending on the caller's input, so the
 * harness needs one PREPARE per statement instead of one per shape.
 *
 * `to` is widened to the whole day, as in `screenings.repository.ts` and
 * `consultations.repository.ts`: `created_at` is a `timestamptz`, so `$5::date` is
 * midnight at the *start* of the day and a closing bound of `<=` would drop every
 * prescription written on the last day asked for.
 */
const FILTERS = `($2::uuid is null or patient_id = $2::uuid)
        and ($3::prescription_status[] is null or status = any($3::prescription_status[]))
        and ($4::date is null or created_at >= $4::date)
        and ($5::date is null or created_at < $5::date + interval '1 day')`;

/**
 * Newest first: the order a patient's prescription history is read in.
 *
 * `id desc` is the tie-break rather than decoration. `created_at` defaults to
 * `now()`, which is transaction-start time, so two prescriptions written in one
 * transaction — one sale supplying against two scripts — carry an identical
 * timestamp, and without a tie-break their order is whatever the planner felt like.
 */
const ORDER_NEWEST = 'order by created_at desc, id desc';

/**
 * Oldest first, which is what an approval queue has to be.
 *
 * A queue sorted newest first buries exactly the prescriptions that need attention:
 * one left `pending` three weeks ago is on page four, where nobody looks, and it
 * stays there because every new prescription pushes it further down. Oldest first
 * means the thing that has been waiting longest is the thing at the top, which is
 * the only ordering in which a queue cannot quietly grow a backlog.
 */
const ORDER_OLDEST = 'order by created_at asc, id asc';

export interface PrescriptionRow {
  id: string;
  pharmacyId: string;
  /**
   * Null for a walk-in who is not on the books. Attaching one later is a real
   * operation — the walk-in becomes a regular — and it is why the column is
   * patchable at all.
   */
  patientId: string | null;
  /**
   * The sale this was dispensed against, or null. Set null by the foreign key when
   * a sale goes, deliberately: see the top of this file.
   */
  saleId: string | null;
  /**
   * A name typed at the counter, not a foreign key. There is no prescribers table
   * and there should not be one for a single pharmacy: the prescriber is whoever
   * wrote the script, most of whom will never be seen twice, and a table of them
   * would be a data-entry burden in exchange for a join nothing needs.
   */
  prescriberName: string | null;
  status: PrescriptionStatus;
  /**
   * Null until somebody approves it. Clearable like every other nullable column
   * here, because an approval recorded against the wrong pharmacist is a signature
   * on a dispensing that pharmacist did not authorise, and leaving it there is
   * worse than the empty column. See `PrescriptionPatch`.
   */
  approvedBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewPrescription {
  pharmacyId: string;
  patientId?: string | null;
  saleId?: string | null;
  prescriberName?: string | null;
  approvedBy?: string | null;
  notes?: string | null;
}

/**
 * What may be changed about a prescription, and the states it may be changed from.
 *
 * Every field except `status` is optional, and `undefined` means "not supplied"
 * while `null` means "clear it" — the distinction `coalesce` cannot make and the
 * reason five of these columns are written with a `case` and a boolean flag.
 *
 * All five are clearable, including the ones it would be tidier to make
 * permanent, and that is deliberate. A prescription attached to the wrong patient
 * has to be detachable: left attached, it is a clinical error on somebody else's
 * record saying they were supplied medicine they never received, and "we cannot
 * correct that here" is not an answer to give a pharmacist. The same is true of a
 * wrong sale, a wrong approver and a misspelt prescriber. What stops this from
 * being a way to erase history is that clearing is an update, which stamps
 * `updated_at`, and section 17 requires the stamp to move.
 */
export interface PrescriptionPatch {
  status?: PrescriptionStatus;
  patientId?: string | null;
  saleId?: string | null;
  approvedBy?: string | null;
  prescriberName?: string | null;
  notes?: string | null;
  /** The statuses the prescription may be in for this patch to apply. */
  allowedFrom: readonly PrescriptionStatus[];
}

export interface PrescriptionFilters {
  /** One patient's prescriptions. Omitted or null means the whole pharmacy. */
  patientId?: string | null;
  /**
   * Restrict to these statuses. Omitted or empty means every status, and empty is
   * folded into "every status" here rather than sent as an empty array:
   * `status = any('{}')` is valid SQL matching no row, so an approval queue asked
   * for nothing would show nothing and read as a pharmacy with nothing waiting.
   */
  statuses?: readonly PrescriptionStatus[];
  /** `YYYY-MM-DD`, inclusive. */
  from?: string | null;
  /** `YYYY-MM-DD`, inclusive of the whole day. */
  to?: string | null;
  /**
   * `'newest'` (the default) for a history and `'oldest'` for an approval queue.
   * Two whole orderings rather than one reversed, because with `limit` and `offset`
   * reversing a page is not reversing an ordering.
   */
  order?: 'newest' | 'oldest';
  limit: number;
  offset: number;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapPrescription(row: Record<string, unknown>): PrescriptionRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    patientId: textOrNull(row.patient_id),
    saleId: textOrNull(row.sale_id),
    prescriberName: textOrNull(row.prescriber_name),
    status: row.status as PrescriptionStatus,
    approvedBy: textOrNull(row.approved_by),
    notes: textOrNull(row.notes),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function createPrescription(
  sql: Sql,
  input: NewPrescription
): Promise<PrescriptionRow> {
  const result = await sql.query(
    `insert into prescriptions
       (pharmacy_id, patient_id, sale_id, prescriber_name, approved_by, notes)
     values ($1, $2, $3, $4, $5, $6)
     returning ${PRESCRIPTION_COLUMNS}`,
    [
      input.pharmacyId,
      input.patientId ?? null,
      input.saleId ?? null,
      input.prescriberName ?? null,
      input.approvedBy ?? null,
      input.notes ?? null,
    ]
  );
  const inserted = result.rows[0];
  if (inserted === undefined) {
    // INSERT ... RETURNING always yields the row it inserted. Nothing on this
    // table can swallow it: there is no unique index and no ON CONFLICT.
    throw new Error('insert into prescriptions returned no row');
  }
  return mapPrescription(inserted);
}

/**
 * One prescription by id, or null.
 *
 * This is what makes a null from `updatePrescription` mean something: call it
 * inside the same transaction, as `sales.service.ts` does before
 * `updateSalePaymentStatus`, and a null return from the guarded update is the guard
 * refusing rather than the row being absent. The two are different sentences — one
 * is a stale link in somebody's browser and the other is a prescription that has
 * already been dispensed.
 */
export async function findPrescription(
  sql: Sql,
  pharmacyId: string,
  prescriptionId: string
): Promise<PrescriptionRow | null> {
  const result = await sql.query(
    `select ${PRESCRIPTION_COLUMNS} from prescriptions
      where pharmacy_id = $1 and id = $2`,
    [pharmacyId, prescriptionId]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapPrescription(first);
}

export async function listPrescriptions(
  sql: Sql,
  pharmacyId: string,
  filters: PrescriptionFilters
): Promise<PrescriptionRow[]> {
  const statuses =
    filters.statuses !== undefined && filters.statuses.length > 0
      ? [...filters.statuses]
      : null;
  const order = filters.order === 'oldest' ? ORDER_OLDEST : ORDER_NEWEST;

  const result = await sql.query(
    `select ${PRESCRIPTION_COLUMNS} from prescriptions
      where pharmacy_id = $1
        and ${FILTERS}
      ${order}
      limit $6 offset $7`,
    [
      pharmacyId,
      filters.patientId ?? null,
      statuses,
      filters.from ?? null,
      filters.to ?? null,
      filters.limit,
      filters.offset,
    ]
  );
  return result.rows.map(mapPrescription);
}

/**
 * How many prescriptions match, for the badge on an approval queue.
 *
 * `count(*)::int` because `count` is a `bigint` and node-pg hands a `bigint` back
 * as a string, which would put `"3"` on a badge and make `waiting > 0` a truthy
 * test on a non-empty string rather than a comparison — true for `"0"`, which is
 * the one value the badge exists to show as empty.
 */
export async function countPrescriptions(
  sql: Sql,
  pharmacyId: string,
  filters: Omit<PrescriptionFilters, 'order' | 'limit' | 'offset'>
): Promise<number> {
  const statuses =
    filters.statuses !== undefined && filters.statuses.length > 0
      ? [...filters.statuses]
      : null;

  const result = await sql.query(
    `select count(*)::int as total from prescriptions
      where pharmacy_id = $1
        and ${FILTERS}`,
    [pharmacyId, filters.patientId ?? null, statuses, filters.from ?? null, filters.to ?? null]
  );
  const row = result.rows[0];
  // An aggregate with no GROUP BY always returns exactly one row, so this branch is
  // unreachable. 0 is the honest value for it rather than a thrown error: a count
  // that cannot be read is a count of nothing, and a badge that fails to render is
  // worse than one that reads zero.
  return row === undefined ? 0 : (row.total as number);
}

/**
 * Applies a patch, or applies nothing and returns null if the guard refused.
 *
 * Fourteen parameters in one fixed shape rather than a `set` list assembled from
 * whichever optionals arrived, for the reason `patients.repository.ts` records: a
 * read-modify-write full-row patch loses whatever a colleague changed in between,
 * and a dynamic builder turns one statement into one per combination — 64 of them
 * here, most of which no test would ever exercise.
 *
 * The guard is in the `where`, so it reads the pre-update status. Passing `status`
 * in the patch and `allowedFrom` beside it is therefore a transition: the row has
 * to be in one of the allowed states in order to leave it, and a `dispensed`
 * prescription guarded on `['pending', 'approved']` matches no row and changes
 * nothing — including `updated_at`, which section 17 requires.
 */
export async function updatePrescription(
  sql: Sql,
  pharmacyId: string,
  prescriptionId: string,
  patch: PrescriptionPatch
): Promise<PrescriptionRow | null> {
  const result = await sql.query(
    `update prescriptions
        set status = coalesce($3::prescription_status, status),
            patient_id = case when $4::boolean then $5::uuid else patient_id end,
            sale_id = case when $6::boolean then $7::uuid else sale_id end,
            approved_by = case when $8::boolean then $9::uuid
                               else approved_by end,
            prescriber_name = case when $10::boolean then $11::text
                                   else prescriber_name end,
            notes = case when $12::boolean then $13::text else notes end
      where pharmacy_id = $1
        and id = $2
        and status = any($14::prescription_status[])
      returning ${PRESCRIPTION_COLUMNS}`,
    [
      pharmacyId,
      prescriptionId,
      patch.status ?? null,
      patch.patientId !== undefined,
      patch.patientId ?? null,
      patch.saleId !== undefined,
      patch.saleId ?? null,
      patch.approvedBy !== undefined,
      patch.approvedBy ?? null,
      patch.prescriberName !== undefined,
      patch.prescriberName ?? null,
      patch.notes !== undefined,
      patch.notes ?? null,
      [...patch.allowedFrom],
    ]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapPrescription(first);
}
