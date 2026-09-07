/**
 * TypeScript mirrors of the Postgres enums.
 *
 * One file, because the alternative is a list per repository and no way to know
 * they still agree with the database. `__tests__/schema-enums.test.ts` reads
 * `database/init.sql` and compares every list here against the `CREATE TYPE`
 * that defines it, in order, so adding a value on one side and not the other
 * fails a suite rather than surfacing as a 22P02 at the counter.
 *
 * Values are the wire vocabulary: they are what the API accepts and returns, and
 * they are compared by `=` against enum columns in SQL. Nothing here is a
 * display label.
 *
 * `UserRole` is deliberately not here. It lives in `utils/permissions.ts` next to
 * the permission map it indexes, and the same test checks it there.
 */

/**
 * `vat_treatment`. Medicines in HS Chapter 30 are exempt, which is the schema
 * default.
 *
 * Re-exported from the shared package rather than listed here a second time. The
 * tax engine validates every line's treatment against its own `VAT_TREATMENTS`,
 * so a second list in this file would be two lists that have to agree — and the
 * way they disagree is a value the API accepts and the engine then refuses, or the
 * reverse. That is a 500 at the till rather than a validation message, on a field
 * the operator cannot see anything wrong with.
 *
 * `schema-enums.test.ts` still compares this against the `CREATE TYPE` in
 * `database/init.sql`, so the re-export strengthens the check rather than weakening
 * it: one list now has to match the database for the API and for the engine at
 * once.
 */
export { VAT_TREATMENTS } from 'a-and-b-chemist-shared';
export type { VatTreatment } from 'a-and-b-chemist-shared';

/**
 * `sell_unit`. `pack` consumes `pack_size` base units per unit sold.
 *
 * Re-exported from the shared package for the same reason as `VAT_TREATMENTS`
 * above, though here the reason is arithmetic rather than vocabulary: `pack_size`
 * turns a base-unit price into a selling-unit price and a selling-unit quantity
 * into base units, and `selling-price.ts` owns both conversions so the till, the
 * quote endpoint, the sale write path and the offline pricer cannot disagree about
 * them. That module has to switch on the values, so a second list here would be
 * two lists that have to agree — and the way they would disagree is a selling unit
 * the API accepts and the conversion then treats as a single, charging a tenth of
 * the price and drawing a tenth of the stock.
 *
 * `schema-enums.test.ts` still compares this against the `CREATE TYPE` in
 * `database/init.sql`, so the re-export strengthens the check rather than
 * weakening it.
 */
export { SELL_UNITS } from 'a-and-b-chemist-shared';
export type { SellUnit } from 'a-and-b-chemist-shared';

/** `sale_status`. */
export const SALE_STATUSES = [
  'pending',
  'completed',
  'voided',
  'refunded',
  'partially_refunded',
] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/**
 * `sale_payment_method`. Two values, and the list is closed on purpose.
 *
 * Card, bank transfer and credit were removed from the tender list before this
 * schema was written, so the enum was authored at its final size and never
 * carried the other four. That ordering is the whole point: Postgres cannot drop
 * a value from an enum, so growing this is one safe statement
 * (`alter type sale_payment_method add value 'insurance'`, which cannot run
 * inside a transaction block) while shrinking it means creating a new type and
 * rewriting the column — and that fails outright while any row still holds the
 * value being removed. A tender nobody has asked for is not a spare capacity, it
 * is a value that can never be taken out again.
 *
 * `momo` is the wire value for mobile money: what the till button sends, what the
 * API accepts and what the column stores are the same word. The UI renders
 * "Mobile money" from it. Nothing in this file is a display label.
 *
 * With no credit tender there is no debtor record and no "owe" list. A customer
 * who cannot pay does not get a sale that quietly becomes a debt: the sale stays
 * `pending`, with stock already drawn from the batches, until the payment is
 * taken or the sale is voided.
 */
export const SALE_PAYMENT_METHODS = ['cash', 'momo'] as const;
export type SalePaymentMethod = (typeof SALE_PAYMENT_METHODS)[number];

/**
 * `sale_payment_status`.
 *
 * `pending` is the state a mobile-money tender is written in, and it is not a
 * failure and not a queue: the gateway has been asked and has not answered. The
 * webhook moves it to `succeeded` or `failed`, and `verify` asks the gateway
 * directly when the webhook has not arrived. A charge response is never trusted
 * on its own — see `services/paystack.service.ts`.
 *
 * `reversed` is a payment that succeeded and was then taken back by the gateway.
 * It is not `failed`: the money moved and moved again, and a till that showed
 * both as the same word would be unable to answer a customer who was debited.
 *
 * Cash never sits in `pending`. It is written `succeeded` in the same transaction
 * as the sale, because the note is in the drawer before the receipt prints.
 */
export const SALE_PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'reversed'] as const;
export type SalePaymentStatus = (typeof SALE_PAYMENT_STATUSES)[number];

/** `stock_movement_type`. Every row in the ledger carries one of these. */
export const MOVEMENT_TYPES = [
  'opening',
  'receive',
  'adjust',
  'write_off',
  'sale',
  'void_restore',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** `notification_type`. */
export const NOTIFICATION_TYPES = [
  'refill_reminder',
  'appointment_reminder',
  'stock_expiry',
  'stock_reorder',
  'product_recall',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * `notification_status`.
 *
 * `not_sent` is not a failure and not a pending: it means nothing was attempted,
 * and the reason is recorded beside it. A stock alert raised in Phase 4 is
 * written as `not_sent` for exactly that reason — it is shown in the app and
 * there is no SMS provider configured to send it anywhere else.
 */
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'not_sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * `gender`. `undisclosed` is a value, not an absence.
 *
 * The column is nullable and a patient who says nothing at all leaves it null,
 * which is what an unasked question should look like in the record. But a
 * patient who is asked and declines has answered, and folding that into null
 * would make "declined" and "never asked" the same row — two facts a pharmacist
 * reading back a record would want apart, because one of them is a gap to fill
 * in at the next visit and the other is a boundary to respect.
 */
export const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * `prescription_status`. One direction, with `rejected` as the only exit.
 *
 * `dispensed` is a fact about medicine that has left the shelf, so nothing moves
 * out of it: a dispensing that was wrong is corrected on the stock ledger with a
 * write-off and on the sale with a refund, not by putting the prescription back
 * to `pending` and losing the record that it was ever supplied.
 */
export const PRESCRIPTION_STATUSES = ['pending', 'approved', 'rejected', 'dispensed'] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

/**
 * `consultation_type`. `video` is a link-out, not a media feature.
 *
 * The column records what was arranged so the diary can say so; the call itself
 * happens on somebody else's infrastructure, reached through `video_url`. A
 * pharmacy booking a handful of consultations a month has no use for a waiting
 * room, signalling and recording pipeline it would have to keep patched.
 */
export const CONSULTATION_TYPES = ['in_person', 'video', 'chat', 'phone'] as const;
export type ConsultationType = (typeof CONSULTATION_TYPES)[number];

/**
 * `consultation_status`. `no_show` is kept apart from `cancelled`.
 *
 * Both end a consultation and neither involves a clinician's time being spent,
 * but they are different facts about a patient: one was called off, the other
 * did not arrive. Collapsing them would leave a diary that cannot tell a
 * pharmacist whether to rebook or to follow up.
 */
export const CONSULTATION_STATUSES = [
  'scheduled',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

/**
 * `screening_type`. What was measured, not what was found.
 *
 * `weight` and `bmi` are separate values even though a BMI screening also
 * records weight: the type names the thing the pharmacist set out to check, and
 * the measurement columns hold whatever was actually taken. `utils/screening.ts`
 * is where the two are reconciled — it refuses a `blood_pressure` screening with
 * no blood pressure in it, because a row that says a measurement was taken is
 * the one kind of empty record a clinician cannot afford.
 */
export const SCREENING_TYPES = [
  'blood_pressure',
  'blood_sugar',
  'bmi',
  'weight',
  'temperature',
  'heart_rate',
] as const;
export type ScreeningType = (typeof SCREENING_TYPES)[number];

/**
 * `risk_level`. A triage aid written down, never a diagnosis.
 *
 * Three values and no fourth for "unclassified": every screening is classified,
 * because `utils/screening.ts` derives the level from the measurements on the
 * server and does not accept one from the caller. A client that could post
 * `low` beside a systolic of 210 would turn the column into an opinion.
 */
export const RISK_LEVELS = ['low', 'moderate', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * `reminder_kind`. Two kinds, and each has its own dedupe shape.
 *
 * A refill reminder is keyed to the prescription that created it, so it is raised
 * once and never again. An appointment reminder is keyed to the consultation
 * *and its scheduled time*, so a rescheduled appointment raises a fresh reminder
 * for the new slot instead of leaving the patient with one about a time that no
 * longer exists.
 *
 * `utils/reminder-keys.ts` builds both keys, and the prefix that
 * `supersedeAppointmentReminders` matches when a slot moves. One module for the
 * format, because the prefix and the key have to agree and a second spelling of
 * either would drift silently — the stale reminder would stay pending, stay in
 * the partial index, and fire for an appointment nobody is expecting.
 */
export const REMINDER_KINDS = ['refill', 'appointment'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
