import { poolSql, withTransaction, type Sql } from '../database/pool';
import { findPatient } from '../repositories/patients.repository';
import {
  countPrescriptions,
  createPrescription,
  findPrescription,
  listPrescriptions,
  updatePrescription,
  type PrescriptionFilters,
  type PrescriptionPatch,
  type PrescriptionRow,
} from '../repositories/prescriptions.repository';
import {
  scheduleReminder,
  supersedeRefillReminder,
} from '../repositories/reminders.repository';
import { findSaleById } from '../repositories/sales.repository';
import { nowIso } from '../utils/clock';
import { HttpError, notFound } from '../utils/http';
import { refillReminderKey } from '../utils/reminder-keys';
import { PRESCRIPTION_STATUSES, type PrescriptionStatus } from '../utils/schema-enums';
import type { Actor } from './inventory.service';
import { PHARMACY_NAME, SMS_BODY_MAX_LENGTH } from './sms';

/**
 * The authority behind a dispensing: recording it, deciding it, and the reminder
 * that decision starts.
 *
 * ## The transition table lives here and not in the repository
 *
 * `prescriptions.repository.ts` takes the states a move may start from as a
 * parameter, exactly as `updateConsultation` and `updateSalePaymentStatus` do, and
 * says why: which transitions are sound is a decision for the module that has to
 * write the sentence explaining a refusal. {@link TRANSITIONS} is that decision,
 * spelled as data so a test can pin the whole of it rather than re-spelling it and
 * agreeing with itself.
 *
 * Four moves exist and no others:
 *
 *   - `pending` to `approved` — a pharmacist has decided to supply.
 *   - `pending` to `rejected` — a pharmacist has decided not to.
 *   - `approved` to `dispensed` — the medicine has left the shelf.
 *   - `approved` to `rejected` — the decision was reversed before anything was handed over.
 *
 * Both `rejected` and `dispensed` are terminal. `dispensed` for the reason
 * `utils/schema-enums.ts` gives: it is a fact about medicine that has left the
 * shelf, corrected on the stock ledger with a write-off and on the sale with a
 * refund, never by un-recording the supply. `rejected` for the same reason in the
 * other direction — a clinical refusal is also a fact, and a route from `rejected`
 * back to `approved` would be a way to turn a refusal into an authorisation while
 * leaving nothing behind but a moved `updated_at`. A refusal that was wrong is
 * answered by a pharmacist making a new decision and recording it as one.
 *
 * Nothing moves *to* `pending`, so `allowedFromFor('pending')` is empty. That
 * empty list is refused before it reaches SQL rather than sent: `status = any('{}')`
 * is valid Postgres matching no row, which would produce the correct 409 by
 * accident, and the repository's own warning about that shape is the reason the
 * answer here is a check instead of a coincidence.
 *
 * ## Approval is a separate act from dispensing
 *
 * There is no move from `pending` straight to `dispensed`, and the reason is
 * `approved_by`. Dispensing without approving would leave medicine that has
 * physically gone with no recorded authority for it — a null in the one column
 * whose job is to say who decided. Making the pharmacist approve first is what
 * puts their id there, and `approvedBy` is taken from the token rather than the
 * request body for the reason `recordedBy` is in `screenings.service.ts`: the
 * approver is the signer, and a signer supplied by the caller is a signature
 * somebody else chose.
 *
 * ## The collection reminder, and why dispensing has to stop it
 *
 * Approving raises one reminder, keyed to the prescription alone by
 * `utils/reminder-keys.ts`. Dispensing and rejecting both supersede it. Without
 * the supersede, a script approved on Monday and collected on Monday still fires
 * on Tuesday, and the patient is texted about medicine they are holding — the
 * exact failure that module names as the reason the key carries no month in it.
 * Keying the reminder correctly stops a *second* one being raised; only
 * `supersedeRefillReminder` stops the *first* one firing.
 *
 * ## What is not here
 *
 * No delete, for the three independent reasons `prescriptions.repository.ts`
 * gives. And no required reason on a rejection, which is a gap worth naming:
 * refusing to supply is a clinical decision a patient may come back and challenge,
 * and the schema has one free-text `notes` column with no place for a refusal
 * reason of its own. Composing one into `notes` would either overwrite what a
 * pharmacist already wrote or append in a format nothing can parse, and both are
 * worse than recording the refusal as a status with a moved `updated_at` and a
 * named approver. A reason of its own is a column, and a column is a migration to
 * decide with A&B rather than invent here.
 */

/**
 * The sentence a patient receives, with the prescriber's place in it marked by the
 * argument.
 *
 * Split out of {@link refillReminderMessage} so the length the form allows can be
 * derived from it rather than chosen beside it. Two constants that have to agree and
 * are written independently are two constants that drift, and this drift is not
 * cosmetic: a name the form accepts but the message will not carry turns "approve"
 * into a 500 at the counter — thrown inside the transaction, after the status has
 * moved, so the approval rolls back and the prescription stays `pending` with no
 * sentence anybody there can act on.
 */
function refillBody(source: string): string {
  return (
    `Your prescription from ${source} is ready for collection. ` +
    'Please call the pharmacy if you need help with it.'
  );
}

/**
 * Everything the collection reminder spends except the prescriber's own name: the
 * sentence, the pharmacy's trading name, and the words that introduce a prescriber.
 */
const REFILL_MESSAGE_OVERHEAD = refillBody(`${PHARMACY_NAME}, prescribed by `).length;

/**
 * The lengths the routes validate against, kept beside the reasoning.
 *
 * `prescriberName`'s maximum is derived and not chosen: it is whatever is left of the
 * two GSM segments `SMS_BODY_MAX_LENGTH` allows once the rest of the sentence has taken
 * its share, so the longest name a route will accept is exactly the longest name the
 * reminder can carry. It used to be 200, to match `PRODUCT_LIMITS.manufacturer`, and at
 * 200 the message ran to 326 characters — the two had already drifted apart and the
 * throw in `refillReminderMessage` was reachable from a body that had passed
 * validation, which is the one shape of failure a length limit exists to prevent.
 *
 * `notes` at 500 matches `PRODUCT_LIMITS.note`. Neither column is length-limited in the
 * schema, so this is the only thing standing between a pasted document and a list of
 * prescriptions that takes a second to render.
 */
export const PRESCRIPTION_LIMITS = {
  prescriberName: { min: 0, max: SMS_BODY_MAX_LENGTH - REFILL_MESSAGE_OVERHEAD },
  notes: { min: 0, max: 500 },
} as const;

/**
 * How long after an approval the collection reminder becomes due.
 *
 * A day, and it is a constant because there is nothing to derive it from: the
 * table holds no supply duration, no expected delivery and no collection window,
 * so any lead is a judgement rather than a calculation. A day is the shortest lead
 * that is not a text to somebody still standing at the counter and the longest one
 * that is still worth receiving — and when the patient *is* at the counter, the
 * dispensing that follows within the hour supersedes it before it ever becomes due.
 *
 * This is the interval that would become real data if A&B ever records days of
 * supply against a prescription. Until then it is a guess, and saying so is what
 * stops it being read as a rule.
 */
export const REFILL_REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Which states each state may move to. Exported so a test pins the whole table
 * rather than one move at a time — four separate assertions can each pass while
 * the shape between them is wrong.
 */
export const TRANSITIONS: Readonly<Record<PrescriptionStatus, readonly PrescriptionStatus[]>> = {
  pending: ['approved', 'rejected'],
  approved: ['dispensed', 'rejected'],
  rejected: [],
  dispensed: [],
};

/** Why a reminder was stopped when the medicine was handed over. */
export const COLLECTED_REASON =
  'The prescription was dispensed, so there is nothing left to collect.';

/** Why a reminder was stopped when the pharmacist decided not to supply. */
export const NOT_SUPPLYING_REASON =
  'The prescription was not approved for supply, so there is nothing to collect.';

/**
 * Why a reminder was stopped when the prescription was re-attached to somebody
 * else.
 *
 * A distinct sentence from the two above because the harm is different and worse:
 * `reminders.patient_id` is a copy taken when the reminder was raised, so leaving
 * it alone would text the *original* patient about medicine prepared for somebody
 * else. That is one patient's information going to another, and the reason is
 * written so the pharmacist who reads it in the bell can see what was prevented
 * rather than only that something was.
 */
export const REATTACHED_REASON =
  'The prescription this reminder belongs to was attached to a different patient record.';

/** One prescription, as the API returns it. Exported for the api-types mirror. */
export type PrescriptionView = PrescriptionRow;

/** What the record form posts. Everything is optional: a walk-in has no patient record. */
export interface PrescriptionInput {
  patientId?: string | null;
  saleId?: string | null;
  prescriberName?: string | null;
  notes?: string | null;
}

/**
 * What a correction may change. No `status`: correcting a typo is not a clinical
 * decision, and a patch that could carry one would be a second route into every
 * transition this module guards.
 *
 * No `approvedBy` either, and it was here in the first draft with the comment
 * "only to undo a wrong attribution" beside it. Two reasons it came out.
 *
 * Re-attributing an approval is not undoing a mistake, it is writing a different
 * signature onto a decision that was made. `approvePrescription` takes the approver
 * from the token for exactly that reason — so the column says who pressed the
 * button — and a correction that could overwrite it would leave that property true
 * of every prescription except the ones somebody edited. A pharmacist who approved
 * the wrong script corrects it by rejecting and re-recording, which leaves both
 * acts on the ledger, rather than by quietly moving the first one onto a colleague.
 *
 * It was also the last field in this module that accepted a user id from a caller.
 * `approved_by` references `users (id)` with no pharmacy in the reference, because
 * Postgres cannot put a two-table condition into a foreign key, so an id belonging
 * to a different pharmacy's pharmacist would have been stored and nothing would
 * have errored. Removing the field closes that without a third copy of
 * `sales.service.ts`'s `resolveApprover` — which is what keeping it would have
 * needed, since `consultations.service.ts` has its own `resolveConductor` for the
 * `conductedBy` a booking genuinely does accept.
 */
export interface PrescriptionCorrection {
  patientId?: string | null;
  saleId?: string | null;
  prescriberName?: string | null;
  notes?: string | null;
}

export interface PrescriptionPage {
  prescriptions: PrescriptionView[];
  /**
   * Every prescription matching the filters, not just the page of them.
   *
   * Carried because `countPrescriptions` exists and its whole purpose is the badge
   * on an approval queue: a badge reading 3 above a list of two rows is a
   * disagreement somebody notices immediately and then stops trusting either number
   * for. The count shares `listPrescriptions`' one `FILTERS` definition, so the two
   * cannot drift — which is the reason the repository spells the predicate once.
   */
  total: number;
  limit: number;
  offset: number;
}

/**
 * The states a move to `target` may start from.
 *
 * Derived from {@link TRANSITIONS} rather than written beside it. A second table
 * spelling the same four moves backwards would agree with the first for as long as
 * nobody edited one of them, and the day somebody did the guard would start
 * allowing a move the documented table says is forbidden — with both tables
 * looking authoritative and nothing failing.
 *
 * Order comes from `PRESCRIPTION_STATUSES`, so the array handed to SQL is stable
 * whatever order the map happens to be written in.
 */
export function allowedFromFor(target: PrescriptionStatus): readonly PrescriptionStatus[] {
  return PRESCRIPTION_STATUSES.filter((from) => TRANSITIONS[from].includes(target));
}

/**
 * The sentence a patient receives when a prescription is approved for collection.
 *
 * The prescriber's name is in it when there is one, because a patient on two
 * scripts would otherwise receive two identical texts with nothing to tell them
 * apart — and "which one is ready" is the first question the message should
 * answer. It falls back to the pharmacy alone rather than to nothing, since a
 * message that does not say who it is from is one a patient has no reason to act on.
 *
 * Plain ASCII throughout, for the reason `appointmentReminderFor` records: one
 * character outside GSM 7-bit's default alphabet moves the whole message to UCS-2
 * and halves what a segment carries. `prescriberName` is the only caller-supplied
 * text in the body and cannot be constrained to ASCII, so a prescriber named with
 * a diacritic costs a segment. That is a shorter message, not a wrong one.
 */
export function refillReminderMessage(prescriberName: string | null): string {
  const source =
    prescriberName === null
      ? PHARMACY_NAME
      : `${PHARMACY_NAME}, prescribed by ${prescriberName}`;
  const message = refillBody(source);

  if (message.length > SMS_BODY_MAX_LENGTH) {
    // Unreachable from a body the routes have validated, because
    // `PRESCRIPTION_LIMITS.prescriberName.max` is derived from this budget rather than
    // chosen beside it. Kept anyway: a derivation somebody later breaks should fail
    // loudly here rather than quietly at the provider. Asserted rather than truncated,
    // because a message cut mid-sentence is one the patient cannot act on, and the
    // honest response to a body that will not fit is a failure somebody can see.
    throw new Error(
      `the collection reminder is ${message.length} characters and the limit is ${SMS_BODY_MAX_LENGTH}`
    );
  }
  return message;
}

/** A patient id that has to exist, or null. Checked inside the caller's transaction. */
async function patientOrThrow(
  client: Sql,
  pharmacyId: string,
  patientId: string | null
): Promise<void> {
  if (patientId === null) return;
  // Looked up rather than left to the foreign key, because the key answers with a
  // constraint name and that is a schema disclosure as well as the wrong status.
  const patient = await findPatient(client, pharmacyId, patientId);
  if (patient === null) throw notFound('patient');
}

/** A sale id that has to exist, or null. Checked inside the caller's transaction. */
async function saleOrThrow(
  client: Sql,
  pharmacyId: string,
  saleId: string | null
): Promise<void> {
  if (saleId === null) return;
  const sale = await findSaleById(client, pharmacyId, saleId);
  if (sale === null) throw notFound('sale');
}

/**
 * Records a prescription. `patients:write`.
 *
 * The one write here that counter staff hold, and deliberately: writing down that a
 * script was handed across the counter is the same kind of act as noting an allergy,
 * and making the two permissions the same would mean only a pharmacist could write
 * down what was in front of them. The control is not on recording but on the split —
 * `utils/permissions.ts` withholds `prescriptions:approve` from staff, so the person
 * who wrote it down cannot be the person who approved it unless they are a pharmacist
 * or the owner. `prescriptions.routes.ts` reasons the same way from the routing side;
 * this comment points at that rather than restating it, because a second copy of a
 * justification is a second copy that can drift, and this one had.
 *
 * The new row is `pending`. There is no parameter through which it could arrive
 * otherwise — the insert names six columns and `status` is not one of them — which
 * section 17 of the harness proves against the real schema rather than against a
 * reading of `init.sql`.
 */
export async function recordPrescription(
  actor: Actor,
  input: PrescriptionInput
): Promise<PrescriptionView> {
  return withTransaction(async (client) => {
    const patientId = input.patientId ?? null;
    const saleId = input.saleId ?? null;
    await patientOrThrow(client, actor.pharmacyId, patientId);
    await saleOrThrow(client, actor.pharmacyId, saleId);

    return createPrescription(client, {
      pharmacyId: actor.pharmacyId,
      patientId,
      saleId,
      prescriberName: input.prescriberName ?? null,
      notes: input.notes ?? null,
      // `approvedBy` deliberately absent. Nothing has been approved yet, and an
      // approver on a pending prescription is a signature on a decision nobody made.
    });
  });
}

/**
 * The guarded move's three optional halves.
 *
 * An options object rather than three parameters because most moves use one of
 * them, and a signature whose every caller passes two no-ops is a signature nobody
 * reads to find out what a move does.
 */
interface MoveOptions {
  /**
   * Extra fields for the move's own patch, applied in the *same* statement.
   *
   * One statement rather than a move followed by a second update. Two updates in a
   * transaction still fire `prescriptions_set_updated_at` twice and still leave a
   * window in which the row holds one status and not the other's fields, and the
   * only thing bought by splitting them is a second copy of the guard.
   */
  patch?: Omit<PrescriptionPatch, 'status' | 'allowedFrom'>;
  /**
   * Runs inside the transaction before the move, for a check that must not go stale
   * between being made and being relied on.
   */
  before?: (client: Sql, existing: PrescriptionRow) => Promise<void>;
  /** Runs inside the transaction after the move. */
  after?: (client: Sql, row: PrescriptionRow) => Promise<void>;
}

/**
 * The guarded move, in one place.
 *
 * `before` and `after` run inside the same transaction as the update, which is what
 * makes a transition and its side effects one thing rather than two that can
 * disagree: a throw rolls the whole of it back, so there is no path that leaves a
 * dispensed prescription with a live reminder or an approved one with none.
 *
 * The hooks are parameters rather than a switch on `target` inside this function
 * because the three moves have genuinely different side effects and a switch here
 * would put the reminder logic in the module whose job is the guard. Each caller
 * stays readable on its own, and the part worth having in one place — the lookup,
 * the guard, and telling a stale link apart from a refused transition — is.
 */
async function movePrescription(
  actor: Actor,
  prescriptionId: string,
  target: PrescriptionStatus,
  options: MoveOptions = {}
): Promise<PrescriptionView> {
  const allowedFrom = allowedFromFor(target);
  if (allowedFrom.length === 0) {
    // Refused here rather than sent to Postgres. An empty `allowedFrom` would
    // produce `status = any('{}')`, which is valid SQL matching no row and would
    // answer 409 correctly — by accident, and by way of the exact shape
    // `prescriptions.repository.ts` warns about.
    throw new HttpError(
      409,
      `Nothing can be moved back to ${target} — a prescription only ever moves forward`,
      { code: 'prescription_not_movable', details: { requested: target } }
    );
  }

  return withTransaction(async (client) => {
    const existing = await findPrescription(client, actor.pharmacyId, prescriptionId);
    // A miss and another pharmacy's prescription answer the same way, for the
    // reason `utils/http.ts` records.
    if (existing === null) throw notFound('prescription');

    if (options.before !== undefined) await options.before(client, existing);

    const row = await updatePrescription(client, actor.pharmacyId, prescriptionId, {
      ...(options.patch ?? {}),
      status: target,
      allowedFrom,
    });
    if (row === null) {
      // Found above and refused by the guard, so this is the status rather than the
      // id — one is a stale link in somebody's browser and the other is a
      // prescription that has already been dispensed.
      throw new HttpError(
        409,
        `This prescription is ${existing.status}, so it cannot be marked ${target}`,
        {
          code: 'prescription_not_movable',
          details: { status: existing.status, requested: target },
        }
      );
    }

    if (options.after !== undefined) await options.after(client, row);
    return row;
  });
}

/**
 * Approves a prescription and raises the collection reminder. `prescriptions:approve`.
 *
 * No reminder when the prescription has no patient on it. A walk-in who is not on
 * the books has nobody to text, and that is a fact about the record rather than an
 * error: `reminders.patient_id` is not null, so the alternative would be either a
 * reminder that cannot be written or a patient record invented to hold one.
 *
 * The reminder is raised against `row.patientId` and not re-read from `patients`.
 * The id came out of the database rather than out of a request body, so the foreign
 * key already checked it when the prescription was written — a second lookup here
 * would be a round trip to confirm something the schema guarantees on every read.
 */
export async function approvePrescription(
  actor: Actor,
  prescriptionId: string
): Promise<PrescriptionView> {
  const now = nowIso();
  const dueAt = new Date(Date.parse(now) + REFILL_REMINDER_LEAD_MS).toISOString();

  return movePrescription(actor, prescriptionId, 'approved', {
    // The signature is written by the move and not by the caller, and in the same
    // statement as the status. `approvedBy` is in `PrescriptionPatch` because a wrong
    // attribution has to be correctable — see `correctPrescription` — and correctable
    // is not the same as choosable.
    patch: { approvedBy: actor.userId },
    after: async (client, row) => {
      if (row.patientId === null) return;

      await scheduleReminder(client, {
        pharmacyId: actor.pharmacyId,
        patientId: row.patientId,
        kind: 'refill',
        dueAt,
        message: refillReminderMessage(row.prescriberName),
        dedupeKey: refillReminderKey(row.id),
      });
    },
  });
}

/**
 * Records that the medicine went, and stops the collection reminder. `prescriptions:approve`.
 *
 * `saleId` is optional and attaches the dispensing to the till transaction that
 * carried it. It is validated here rather than left to the foreign key for the
 * reason the patient is.
 */
export async function dispensePrescription(
  actor: Actor,
  prescriptionId: string,
  saleId?: string | null
): Promise<PrescriptionView> {
  const wanted = saleId ?? null;

  return movePrescription(actor, prescriptionId, 'dispensed', {
    ...(wanted === null ? {} : { patch: { saleId: wanted } }),
    // Checked inside the transaction rather than before it, so the id cannot go
    // stale between being found and being written and so a miss answers 404 rather
    // than the foreign key's constraint name.
    before: async (client) => {
      await saleOrThrow(client, actor.pharmacyId, wanted);
    },
    after: async (client, row) => {
      // Superseded whether or not a reminder exists. Zero rows is the normal answer
      // — a script approved and collected in one visit has its reminder cancelled
      // before it ever becomes due — so the boolean is not returned to the caller
      // and there is nothing to do with it.
      await supersedeRefillReminder(client, actor.pharmacyId, row.id, COLLECTED_REASON);
    },
  });
}

/**
 * Records that the pharmacy is not supplying, and stops the collection reminder.
 * `prescriptions:approve`.
 *
 * Available from `pending` and from `approved`. The second is the one that needs
 * the supersede: a prescription already approved has already raised a reminder, and
 * a patient told to collect medicine the pharmacy then refused is worse than a
 * patient never told.
 */
export async function rejectPrescription(
  actor: Actor,
  prescriptionId: string
): Promise<PrescriptionView> {
  return movePrescription(actor, prescriptionId, 'rejected', {
    after: async (client, row) => {
      await supersedeRefillReminder(client, actor.pharmacyId, row.id, NOT_SUPPLYING_REASON);
    },
  });
}

/**
 * Corrects the record without moving its status. `prescriptions:approve`.
 *
 * Every field is clearable, including the ones it would be tidier to make
 * permanent, and `prescriptions.repository.ts` records why: a prescription attached
 * to the wrong patient left attached is a clinical error on somebody else's record
 * saying they were supplied medicine they never received, and "we cannot correct
 * that here" is not an answer to give a pharmacist. What stops this from being a
 * way to erase history is that a correction is an update, so it stamps `updated_at`,
 * and section 17 requires the stamp to move.
 *
 * `allowedFrom` is all four statuses. A typo on a dispensed prescription is still a
 * typo, and refusing to fix it would leave wrong information on the one row that
 * says medicine went out — correcting the attribution does not un-record the supply.
 *
 * Re-attaching to a different patient stops the collection reminder, because
 * `reminders.patient_id` is a copy taken when the reminder was raised. Left alone it
 * would text the original patient about medicine prepared for somebody else, which
 * is one patient's information going to another.
 */
export async function correctPrescription(
  actor: Actor,
  prescriptionId: string,
  input: PrescriptionCorrection
): Promise<PrescriptionView> {
  const patch: Omit<PrescriptionPatch, 'allowedFrom'> = {
    ...(input.patientId === undefined ? {} : { patientId: input.patientId }),
    ...(input.saleId === undefined ? {} : { saleId: input.saleId }),
    ...(input.prescriberName === undefined ? {} : { prescriberName: input.prescriberName }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
  if (Object.keys(patch).length === 0) {
    // Reported rather than answered with an unchanged row: a silent no-op is a
    // frontend that believes it saved something it did not send.
    throw new HttpError(400, 'Nothing to change — send at least one field to correct', {
      code: 'nothing_to_update',
    });
  }

  return withTransaction(async (client) => {
    const existing = await findPrescription(client, actor.pharmacyId, prescriptionId);
    if (existing === null) throw notFound('prescription');

    const patientId = input.patientId === undefined ? existing.patientId : input.patientId;
    const reattached = input.patientId !== undefined && input.patientId !== existing.patientId;
    await patientOrThrow(client, actor.pharmacyId, patientId);
    await saleOrThrow(
      client,
      actor.pharmacyId,
      input.saleId === undefined ? null : input.saleId
    );

    const row = await updatePrescription(client, actor.pharmacyId, prescriptionId, {
      ...patch,
      allowedFrom: PRESCRIPTION_STATUSES,
    });
    if (row === null) {
      // Unreachable while `allowedFrom` is every status, and kept because a future
      // narrowing of it would otherwise turn into a row silently not updated. A null
      // from a guarded update is the guard refusing, not the row being absent.
      throw notFound('prescription');
    }

    if (reattached) {
      await supersedeRefillReminder(client, actor.pharmacyId, row.id, REATTACHED_REASON);
    }
    return row;
  });
}

/** `patients:read`, because a prescription history is read by the same people as the record it belongs to. */
export async function getPrescription(
  pharmacyId: string,
  prescriptionId: string
): Promise<PrescriptionView> {
  const row = await findPrescription(poolSql, pharmacyId, prescriptionId);
  if (row === null) throw notFound('prescription');
  return row;
}

/**
 * The list, and the badge's number beside it. `patients:read`.
 *
 * Both reads outside a transaction, for the reason `listPatientPage` records: the
 * cost of making the pair exact is a lock held across two queries to serve a queue,
 * and the inaccuracy it buys is a badge one approval out for the milliseconds
 * between them.
 *
 * The count is asked for with the same filters minus the paging, which is the whole
 * point of `countPrescriptions` taking an `Omit`: a badge counting the pharmacy's
 * prescriptions beside a page of the pending ones would be a number that looks
 * authoritative and means something else.
 */
export async function listPrescriptionPage(
  pharmacyId: string,
  filters: PrescriptionFilters
): Promise<PrescriptionPage> {
  const [prescriptions, total] = await Promise.all([
    listPrescriptions(poolSql, pharmacyId, filters),
    countPrescriptions(poolSql, pharmacyId, {
      patientId: filters.patientId,
      statuses: filters.statuses,
      from: filters.from,
      to: filters.to,
    }),
  ]);
  return {
    prescriptions,
    total,
    limit: filters.limit,
    offset: filters.offset,
  };
}
