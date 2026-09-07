import type { Sql } from '../database/pool';
import { HttpError } from '../utils/http';
import { likePattern } from './inventory.repository';
import type {
  SalePaymentMethod,
  SalePaymentStatus,
  SaleStatus,
  SellUnit,
  VatTreatment,
} from '../utils/schema-enums';

/**
 * Sales, their lines, the lot junction, and the tenders that settle them.
 *
 * Three rules shape every statement here.
 *
 * The first is enum parameters, and it is the landmine that stopped every sale on
 * the previous build. node-postgres sends every parameter untyped, so Postgres
 * infers each one's type from all of its uses. A parameter assigned to an enum
 * column needs no cast — the column supplies the type. A parameter *compared*
 * against one does, because a comparison hands the parser two unknowns to resolve
 * between and it picks text; when the same parameter is also assigned to an enum
 * column the statement is rejected at parse time with `inconsistent types deduced
 * for parameter $n / DETAIL: text versus sale_status`. Every sale then fails with a
 * bare HTTP 500 that looks like a payment-gateway problem. Casts below appear
 * where they are load-bearing and say so; where one is present for a different
 * reason, the comment says that instead rather than claiming a necessity that is
 * not there. `coalesce($n, column)` supplies a genuine type context and is immune
 * — statements using it are not "fixed".
 *
 * The second is that the four tax snapshot columns on `sales` — `vat_rate`,
 * `nhil_rate`, `getfund_rate`, `tax_inclusive_pricing` — are NOT NULL with no
 * default, so `NewSale` carries them and it is a compile error to build one
 * without them. A sale cannot be stored without the rates it charged. ASSERT 8f in
 * `database/tests/assertions.sql` guards the schema half of that.
 *
 * The third is the `Sql` parameter, for the reason given in `database/pool.ts`: a
 * sale is seven writes that must all land or none, and an optional trailing
 * `client?` would let a caller forget it and quietly perform one of them outside
 * the transaction.
 *
 * Units, because two of them appear in one sale and mixing them is a stock error
 * nobody can see. `sale_items.quantity` is **selling units** — what the receipt
 * says and what the customer counts. `sale_item_batches.quantity` is **base
 * units** — what left the drawer. A line of two strips of ten has `quantity` 2 and
 * junction rows summing to 20, and `recallTrace` in the inventory repository reads
 * the junction, so it reports 20 base units of a recalled lot.
 */

const SALE_COLUMNS = `id, pharmacy_id, sale_number, status, served_by, approved_by, patient_id,
  subtotal, discount, discount_reason, vat_amount, nhil_amount, getfund_amount, tax_total,
  total, amount_paid, change_given, vat_rate, nhil_rate, getfund_rate, tax_inclusive_pricing,
  client_sale_id, voided_at, void_reason, created_at, updated_at`;

const SALE_ITEM_COLUMNS = `id, sale_id, inventory_id, description, sell_unit, quantity,
  unit_price, line_gross, line_discount, taxable_base, vat_amount, nhil_amount,
  getfund_amount, line_total, vat_treatment, created_at`;

const SALE_PAYMENT_COLUMNS = `id, sale_id, method, status, amount, reference,
  gateway_response, paid_at, created_at, updated_at`;

/**
 * The receipt number's shape: `S-` and then digits, zero-padded to six.
 *
 * Sequential rather than derived from the row's uuid, because a receipt number is
 * read aloud at a counter and written into a paper book. A number that jumps
 * between `S-000123` and `9f2c…` is one a pharmacist cannot repeat back, and
 * "which sale was that" becomes a lookup instead of an answer.
 */
const SALE_NUMBER_PREFIX = 'S-';
const SALE_NUMBER_DIGITS = 6;

/**
 * Captures the digits of a receipt number, for the `max()` below.
 *
 * Used as a SQL regex parameter rather than interpolated into the statement, so
 * the prefix stays in one constant and no part of a query string is built by
 * concatenation. A row whose number does not match yields NULL, which `max()`
 * ignores — which is what makes this immune to the other things in the table. The
 * schema harness writes rows numbered `HARNESS-SALE-…` and deletes them again, and
 * a `count(*)`-based scheme would produce a duplicate receipt number the day it
 * ran; this reads the highest number we actually issued and nothing else.
 */
const SALE_NUMBER_CAPTURE = `^${SALE_NUMBER_PREFIX}([0-9]+)$`;

/** `23505` is raised by both of these, and they mean opposite things. See `insertSale`. */
const SALE_NUMBER_CONSTRAINT = 'sales_pharmacy_id_sale_number_key';
const CLIENT_SALE_ID_CONSTRAINT = 'sales_client_sale_id_key';

export interface SaleRow {
  id: string;
  pharmacyId: string;
  saleNumber: string;
  status: SaleStatus;
  servedBy: string;
  approvedBy: string | null;
  patientId: string | null;
  /** Decimal string, as Postgres returns a `numeric`. Never a double. */
  subtotal: string;
  discount: string;
  discountReason: string | null;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  changeGiven: string;
  /** Decimal string from `numeric(5, 4)`, so `'0.1500'` — four places, never trimmed. */
  vatRate: string;
  nhilRate: string;
  getfundRate: string;
  taxInclusivePricing: boolean;
  clientSaleId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaleItemRow {
  id: string;
  saleId: string;
  inventoryId: string;
  /** Snapshot of the name at the moment of sale, so renaming a product cannot rewrite an old receipt. */
  description: string;
  sellUnit: SellUnit;
  /** Selling units, not base units. See the file header. */
  quantity: number;
  /** Decimal string, per selling unit. */
  unitPrice: string;
  lineGross: string;
  lineDiscount: string;
  taxableBase: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  lineTotal: string;
  vatTreatment: VatTreatment;
  createdAt: string;
}

export interface SaleItemBatchRow {
  id: string;
  saleItemId: string;
  batchId: string;
  lotNumber: string;
  /** Base units drawn from this batch. */
  quantity: number;
  /** Decimal string from `numeric(12, 4)`: the batch's cost, snapshotted. */
  unitCost: string;
}

export interface SalePaymentRow {
  id: string;
  saleId: string;
  method: SalePaymentMethod;
  status: SalePaymentStatus;
  amount: string;
  reference: string | null;
  /** The gateway's own payload, verbatim. `jsonb` arrives already parsed. */
  gatewayResponse: unknown;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewSale {
  pharmacyId: string;
  saleNumber: string;
  status: SaleStatus;
  servedBy: string;
  approvedBy: string | null;
  patientId: string | null;
  subtotal: string;
  discount: string;
  discountReason: string | null;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  changeGiven: string;
  vatRate: string;
  nhilRate: string;
  getfundRate: string;
  taxInclusivePricing: boolean;
  clientSaleId: string | null;
}

export interface NewSaleItem {
  saleId: string;
  inventoryId: string;
  description: string;
  sellUnit: SellUnit;
  quantity: number;
  unitPrice: string;
  lineGross: string;
  lineDiscount: string;
  taxableBase: string;
  vatAmount: string;
  nhilAmount: string;
  getfundAmount: string;
  lineTotal: string;
  vatTreatment: VatTreatment;
}

export interface NewSalePayment {
  saleId: string;
  method: SalePaymentMethod;
  status: SalePaymentStatus;
  amount: string;
  reference: string | null;
  gatewayResponse: unknown;
  paidAt: string | null;
}

/** One row of the `/sales` history list: the sale, and who to ask about it. */
export interface SaleListItem {
  id: string;
  saleNumber: string;
  status: SaleStatus;
  createdAt: string;
  servedByName: string;
  patientName: string | null;
  total: string;
  amountPaid: string;
  changeGiven: string;
  /** Lines on the receipt, so the list can say "3 items" without fetching them. */
  itemCount: number;
  paymentMethods: SalePaymentMethod[];
}

export interface SaleFilters {
  status?: SaleStatus | null;
  /** `'YYYY-MM-DD'`, inclusive. */
  from?: string | null;
  to?: string | null;
  servedBy?: string | null;
  search?: string | null;
  limit: number;
  offset: number;
}

/** `timestamptz` arrives as a `Date`; the API speaks ISO-8601 strings. */
function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapSale(row: Record<string, unknown>): SaleRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    saleNumber: row.sale_number as string,
    status: row.status as SaleStatus,
    servedBy: row.served_by as string,
    approvedBy: textOrNull(row.approved_by),
    patientId: textOrNull(row.patient_id),
    subtotal: row.subtotal as string,
    discount: row.discount as string,
    discountReason: textOrNull(row.discount_reason),
    vatAmount: row.vat_amount as string,
    nhilAmount: row.nhil_amount as string,
    getfundAmount: row.getfund_amount as string,
    taxTotal: row.tax_total as string,
    total: row.total as string,
    amountPaid: row.amount_paid as string,
    changeGiven: row.change_given as string,
    vatRate: row.vat_rate as string,
    nhilRate: row.nhil_rate as string,
    getfundRate: row.getfund_rate as string,
    taxInclusivePricing: row.tax_inclusive_pricing as boolean,
    clientSaleId: textOrNull(row.client_sale_id),
    voidedAt: toIsoOrNull(row.voided_at as Date | null),
    voidReason: textOrNull(row.void_reason),
    createdAt: toIso(row.created_at as Date),
    updatedAt: toIso(row.updated_at as Date),
  };
}

function mapSaleItem(row: Record<string, unknown>): SaleItemRow {
  return {
    id: row.id as string,
    saleId: row.sale_id as string,
    inventoryId: row.inventory_id as string,
    description: row.description as string,
    sellUnit: row.sell_unit as SellUnit,
    quantity: row.quantity as number,
    unitPrice: row.unit_price as string,
    lineGross: row.line_gross as string,
    lineDiscount: row.line_discount as string,
    taxableBase: row.taxable_base as string,
    vatAmount: row.vat_amount as string,
    nhilAmount: row.nhil_amount as string,
    getfundAmount: row.getfund_amount as string,
    lineTotal: row.line_total as string,
    vatTreatment: row.vat_treatment as VatTreatment,
    createdAt: toIso(row.created_at as Date),
  };
}

function mapSalePayment(row: Record<string, unknown>): SalePaymentRow {
  return {
    id: row.id as string,
    saleId: row.sale_id as string,
    method: row.method as SalePaymentMethod,
    status: row.status as SalePaymentStatus,
    amount: row.amount as string,
    reference: textOrNull(row.reference),
    gatewayResponse: row.gateway_response ?? null,
    paidAt: toIsoOrNull(row.paid_at as Date | null),
    createdAt: toIso(row.created_at as Date),
    updatedAt: toIso(row.updated_at as Date),
  };
}

/**
 * The next receipt number, and the lock that makes it the next one.
 *
 * Must be called on a transaction client. `pg_advisory_xact_lock` is released when
 * the transaction ends, which is what holds the lock across the read of `max()`
 * and the insert that uses it; called outside a transaction each statement is its
 * own, the lock is released before the number is used, and two concurrent sales
 * take the same one.
 *
 * That is not left as the only defence. `unique (pharmacy_id, sale_number)` is the
 * backstop, and `insertSale` turns a violation of it into a 409 naming the receipt
 * number rather than letting it surface as a 500 — so a caller that gets this wrong
 * fails loudly on the first concurrent sale instead of quietly reissuing numbers.
 *
 * One lock per pharmacy, held for the length of one sale's write path. At a
 * community pharmacy's counter that is milliseconds and a handful of tills, and
 * what it buys is a receipt book with no gaps and no duplicates: a rolled-back
 * sale never consumes a number, and a voided one keeps its number forever, which
 * is what an auditor expects to see.
 */
export async function nextSaleNumber(sql: Sql, pharmacyId: string): Promise<string> {
  // Namespaced by pharmacy id so the lock is per pharmacy and cannot collide with
  // an advisory lock taken for any other purpose in this codebase.
  await sql.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `a-and-b-chemist:sale_number:${pharmacyId}`,
  ]);

  const result = await sql.query(
    `select coalesce(max(substring(sale_number from $2)::bigint), 0) as last_number
       from sales
      where pharmacy_id = $1`,
    [pharmacyId, SALE_NUMBER_CAPTURE]
  );

  // `bigint` arrives as a string, because node-pg will not put a 64-bit integer
  // into a double it cannot represent exactly. It is a count of sales in one
  // pharmacy here, so the value is small and `Number()` is exact — but reading it
  // as a number without saying so is how a string ends up concatenated instead of
  // incremented, and `S-000123` becomes `S-0001231`.
  const raw = result.rows[0]?.last_number;
  const last = typeof raw === 'string' ? Number(raw) : Number(raw ?? 0);
  if (!Number.isSafeInteger(last) || last < 0) {
    throw new Error(`unreadable receipt number sequence for pharmacy ${pharmacyId}`);
  }

  return `${SALE_NUMBER_PREFIX}${String(last + 1).padStart(SALE_NUMBER_DIGITS, '0')}`;
}

/**
 * Writes the sale row.
 *
 * `$3` is cast to `sale_status` and the cast is **not** load-bearing: an assignment
 * deduces the type from the column. It is here because this is the statement the
 * landmine names — twenty-one parameters, one of them an enum — and the edit that
 * breaks it is an ordinary one. Adding `case when $3 = 'completed' then …` to this
 * same statement gives `$3` a second use against a text literal, the parser deduces
 * two incompatible types, and every sale in the pharmacy starts failing at parse
 * time with a 500 that reads like a gateway outage. The cast costs nothing and
 * makes that edit safe.
 *
 * Parameters are listed in column order and the placeholders run `$1` to `$21` in
 * step with them. That is worth a sentence because it was not true of the first
 * draft of this statement, which put the cast on `$4` and the enum at position
 * three: it ran correctly, and it was a trap — anybody adding a column between
 * `sale_number` and `served_by` would have had to notice that two placeholders were
 * deliberately transposed before they could tell whether their edit was wrong.
 *
 * The two unique constraints on this table raise the same `23505` and mean opposite
 * things, which is why they are told apart by name rather than handled together. A
 * duplicate `client_sale_id` is the idempotency path working: the client retried a
 * sale whose response it never received, and the answer is the sale that already
 * exists, not an error. A duplicate `sale_number` is a bug in the numbering above.
 */
export async function insertSale(sql: Sql, input: NewSale): Promise<SaleRow> {
  try {
    const result = await sql.query(
      `insert into sales
         (pharmacy_id, sale_number, status, served_by, approved_by, patient_id,
          subtotal, discount, discount_reason, vat_amount, nhil_amount, getfund_amount,
          tax_total, total, amount_paid, change_given, vat_rate, nhil_rate, getfund_rate,
          tax_inclusive_pricing, client_sale_id)
       values ($1, $2, $3::sale_status, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19, $20, $21)
       returning ${SALE_COLUMNS}`,
      [
        input.pharmacyId,
        input.saleNumber,
        input.status,
        input.servedBy,
        input.approvedBy,
        input.patientId,
        input.subtotal,
        input.discount,
        input.discountReason,
        input.vatAmount,
        input.nhilAmount,
        input.getfundAmount,
        input.taxTotal,
        input.total,
        input.amountPaid,
        input.changeGiven,
        input.vatRate,
        input.nhilRate,
        input.getfundRate,
        input.taxInclusivePricing,
        input.clientSaleId,
      ]
    );
    const inserted = result.rows[0];
    if (inserted === undefined) {
      throw new Error('insert into sales returned no row');
    }
    return mapSale(inserted);
  } catch (error) {
    const constraint = (error as { code?: string; constraint?: string }).constraint;
    if ((error as { code?: string }).code === '23505') {
      if (constraint === CLIENT_SALE_ID_CONSTRAINT) {
        throw new HttpError(409, 'That sale has already been recorded', {
          code: 'sale_already_recorded',
        });
      }
      if (constraint === SALE_NUMBER_CONSTRAINT) {
        throw new HttpError(409, 'Two receipts took the same number. Try this sale again.', {
          code: 'sale_number_taken',
        });
      }
    }
    throw error;
  }
}

/**
 * Writes one line and hands back its id, which the lot junction needs.
 *
 * `sell_unit` and `vat_treatment` are assigned and not compared, so neither is
 * cast: the column supplies the type. `$4` is left to deduction deliberately, so
 * that the casts in this file continue to mean something — a cast on every enum
 * parameter everywhere is a cast nobody reads.
 */
export async function insertSaleItem(sql: Sql, input: NewSaleItem): Promise<SaleItemRow> {
  const result = await sql.query(
    `insert into sale_items
       (sale_id, inventory_id, description, sell_unit, quantity, unit_price, line_gross,
        line_discount, taxable_base, vat_amount, nhil_amount, getfund_amount, line_total,
        vat_treatment)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning ${SALE_ITEM_COLUMNS}`,
    [
      input.saleId,
      input.inventoryId,
      input.description,
      input.sellUnit,
      input.quantity,
      input.unitPrice,
      input.lineGross,
      input.lineDiscount,
      input.taxableBase,
      input.vatAmount,
      input.nhilAmount,
      input.getfundAmount,
      input.lineTotal,
      input.vatTreatment,
    ]
  );
  const inserted = result.rows[0];
  if (inserted === undefined) {
    throw new Error('insert into sale_items returned no row');
  }
  return mapSaleItem(inserted);
}

/**
 * Records which batch a line drew from, and how much.
 *
 * `quantity` is base units. This is the row that makes a void safe and a recall
 * answerable: without it, restoring stock would mean adding units to a product
 * total that `recompute_inventory_from_batches` overwrites from the batches on the
 * next write, and a recall would have no way to find who bought the affected lot.
 */
export async function insertSaleItemBatch(
  sql: Sql,
  input: { saleItemId: string; batchId: string; quantity: number; unitCost: string }
): Promise<void> {
  await sql.query(
    `insert into sale_item_batches (sale_item_id, batch_id, quantity, unit_cost)
     values ($1, $2, $3, $4)`,
    [input.saleItemId, input.batchId, input.quantity, input.unitCost]
  );
}

/**
 * Writes a tender.
 *
 * `method` and `status` are assigned, so neither is cast. `amount` is checked
 * positive by the column, which is why the service refuses a zero-amount tender
 * before it gets here rather than letting the constraint say so: `check (amount >
 * 0)` arriving as a 500 is a schema disclosure, and the message a cashier needs is
 * "enter an amount greater than zero".
 */
export async function insertSalePayment(sql: Sql, input: NewSalePayment): Promise<SalePaymentRow> {
  const result = await sql.query(
    `insert into sale_payments (sale_id, method, status, amount, reference, gateway_response, paid_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${SALE_PAYMENT_COLUMNS}`,
    [
      input.saleId,
      input.method,
      input.status,
      input.amount,
      input.reference,
      input.gatewayResponse === null ? null : JSON.stringify(input.gatewayResponse),
      input.paidAt,
    ]
  );
  const inserted = result.rows[0];
  if (inserted === undefined) {
    throw new Error('insert into sale_payments returned no row');
  }
  return mapSalePayment(inserted);
}

/**
 * Reads a sale for the response, not for a decision.
 *
 * Every read is scoped by `pharmacy_id` even though `id` is a primary key: a uuid
 * from another tenant must not answer here, and the day this is copied into a
 * multi-tenant build is the day the missing scope becomes a disclosure.
 */
export async function findSaleById(
  sql: Sql,
  pharmacyId: string,
  id: string
): Promise<SaleRow | null> {
  const result = await sql.query(
    `select ${SALE_COLUMNS} from sales where pharmacy_id = $1 and id = $2`,
    [pharmacyId, id]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapSale(first);
}

/** The idempotency read: has this client already recorded this sale? */
export async function findSaleByClientSaleId(
  sql: Sql,
  pharmacyId: string,
  clientSaleId: string
): Promise<SaleRow | null> {
  const result = await sql.query(
    `select ${SALE_COLUMNS} from sales where pharmacy_id = $1 and client_sale_id = $2`,
    [pharmacyId, clientSaleId]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapSale(first);
}

/**
 * May this sale name this patient?
 *
 * A sale-path question rather than the start of a patients repository: the only
 * thing the write path needs to know is whether the id it is about to store will
 * be accepted. `sales.patient_id` references `patients (id)` with no `on delete`
 * action, so an id that does not exist arrives as `23503` — a foreign key
 * violation surfacing as a bare 500 that tells the operator nothing about which
 * field was wrong.
 *
 * Scoped by `pharmacy_id` because a patient id from another pharmacy is exactly
 * as unusable here as one that does not exist, and must not be distinguishable
 * from it: a sale naming somebody else's patient is a disclosure, and "no such
 * patient" is the only honest answer to give either way.
 */
export async function patientExists(
  sql: Sql,
  pharmacyId: string,
  patientId: string
): Promise<boolean> {
  const result = await sql.query(
    'select 1 from patients where pharmacy_id = $1 and id = $2',
    [pharmacyId, patientId]
  );
  return result.rows.length > 0;
}

/**
 * Reads a sale `for update`, for the status transitions.
 *
 * A void and a payment both read the sale, decide from what they read, and write
 * it back. Without the lock two of them interleave and the second overwrites a
 * settlement the first had already completed — a sale marked `completed` twice, or
 * a void restoring stock that a concurrent payment had just settled against. The
 * lock is on the sale row, which is the thing both paths contend for.
 */
export async function lockSale(
  sql: Sql,
  pharmacyId: string,
  id: string
): Promise<SaleRow | null> {
  const result = await sql.query(
    `select ${SALE_COLUMNS} from sales where pharmacy_id = $1 and id = $2 for update`,
    [pharmacyId, id]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapSale(first);
}

export async function listSaleItems(sql: Sql, saleId: string): Promise<SaleItemRow[]> {
  const result = await sql.query(
    `select ${SALE_ITEM_COLUMNS} from sale_items where sale_id = $1 order by created_at, id`,
    [saleId]
  );
  return result.rows.map(mapSaleItem);
}

/**
 * Every lot every line of a sale drew from.
 *
 * Joined through `sale_items` because the junction hangs off the line and the
 * caller asks by sale. Ordered by line so a void restores in the order the units
 * were taken, which makes the ledger read the same forwards and backwards.
 */
export async function listSaleItemBatches(
  sql: Sql,
  saleId: string
): Promise<Array<SaleItemBatchRow & { inventoryId: string }>> {
  const result = await sql.query(
    `select sib.id, sib.sale_item_id, sib.batch_id, sib.quantity, sib.unit_cost,
            b.lot_number, si.inventory_id
       from sale_item_batches sib
       join sale_items si on si.id = sib.sale_item_id
       join inventory_batches b on b.id = sib.batch_id
      where si.sale_id = $1
      order by si.created_at, si.id, sib.id`,
    [saleId]
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    saleItemId: row.sale_item_id as string,
    batchId: row.batch_id as string,
    lotNumber: row.lot_number as string,
    quantity: row.quantity as number,
    unitCost: row.unit_cost as string,
    inventoryId: row.inventory_id as string,
  }));
}

export async function listSalePayments(sql: Sql, saleId: string): Promise<SalePaymentRow[]> {
  const result = await sql.query(
    `select ${SALE_PAYMENT_COLUMNS} from sale_payments where sale_id = $1 order by created_at, id`,
    [saleId]
  );
  return result.rows.map(mapSalePayment);
}

/**
 * The `/sales` history list.
 *
 * `$2` carries the optional status filter and is cast, and this cast **is**
 * load-bearing. The parameter is used twice: once against nothing at all in `is
 * null`, which supplies no type, and once compared against `s.status`. Left
 * uncast the parser resolves it from the comparison today, but the same shape with
 * a literal beside it — `or $2 = 'all'`, the edit somebody makes to let the UI send
 * one value meaning "no filter" — gives it a second, incompatible deduction and the
 * whole statement stops parsing. The cast is what makes that edit safe.
 *
 * `payment_methods` is aggregated rather than joined into rows, so one sale is one
 * row of the result however many tenders settled it. A join would repeat the sale
 * per tender and `limit` would then cut through the middle of one sale's payments.
 */
export async function listSales(
  sql: Sql,
  pharmacyId: string,
  filters: SaleFilters
): Promise<SaleListItem[]> {
  const values: unknown[] = [pharmacyId];
  const push = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const where: string[] = ['s.pharmacy_id = $1'];
  if (filters.status !== undefined && filters.status !== null) {
    where.push(`s.status = ${push(filters.status)}::sale_status`);
  }
  if (filters.servedBy !== undefined && filters.servedBy !== null) {
    where.push(`s.served_by = ${push(filters.servedBy)}`);
  }
  if (filters.from !== undefined && filters.from !== null) {
    // Compared against `created_at`, a timestamptz, so the date is widened to the
    // start of that day rather than compared as text: `created_at >= '2026-09-04'`
    // means midnight in the session timezone, which is what "sales since Tuesday"
    // is asking for.
    where.push(`s.created_at >= ${push(filters.from)}::timestamptz`);
  }
  if (filters.to !== undefined && filters.to !== null) {
    // One day added and compared with `<`, so the whole of the closing day is
    // included. `created_at <= '2026-09-04'` would mean midnight at the *start* of
    // the 4th and quietly drop every sale made that day.
    where.push(`s.created_at < (${push(filters.to)}::date + interval '1 day')`);
  }
  if (filters.search !== undefined && filters.search !== null && filters.search !== '') {
    where.push(`s.sale_number ilike ${push(likePattern(filters.search))}`);
  }

  const result = await sql.query(
    `select s.id, s.sale_number, s.status, s.created_at, s.total, s.amount_paid,
            s.change_given, s.patient_id,
            u.full_name as served_by_name,
            p.full_name as patient_name,
            (select count(*) from sale_items si where si.sale_id = s.id) as item_count,
            coalesce(
              (select array_agg(sp.method order by sp.created_at, sp.id)
                 from sale_payments sp
                where sp.sale_id = s.id),
              '{}'
            ) as payment_methods
       from sales s
       join users u on u.id = s.served_by
       left join patients p on p.id = s.patient_id
      where ${where.join(' and ')}
      order by s.created_at desc, s.id desc
      limit ${push(filters.limit)} offset ${push(filters.offset)}`,
    values
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    saleNumber: row.sale_number as string,
    status: row.status as SaleStatus,
    createdAt: toIso(row.created_at as Date),
    servedByName: row.served_by_name as string,
    patientName: textOrNull(row.patient_name),
    total: row.total as string,
    amountPaid: row.amount_paid as string,
    changeGiven: row.change_given as string,
    // `count(*)` is a bigint and arrives as a string, for the reason given in
    // `nextSaleNumber`. A line count is small, so the conversion is exact.
    itemCount: Number(row.item_count as string | number),
    paymentMethods: (row.payment_methods as SalePaymentMethod[] | null) ?? [],
  }));
}

/**
 * Records what has been paid and what the sale now is.
 *
 * Both are written in one statement, because they are one fact: a sale is
 * `completed` exactly when what has been paid covers what is owed. Splitting them
 * across two updates leaves a window where the money has arrived and the status has
 * not, and a till polling in that window shows a paid sale as unpaid.
 *
 * `status` is assigned, so it is not cast. The `where` clause compares the *stored*
 * status against a literal, and both sides of that comparison are known types —
 * the column is `sale_status` and the literal is cast to match — so no parameter is
 * involved and there is nothing for the parser to get wrong.
 */
export async function updateSaleSettlement(
  sql: Sql,
  saleId: string,
  input: { amountPaid: string; changeGiven: string; status: SaleStatus }
): Promise<SaleRow | null> {
  const result = await sql.query(
    `update sales
        set amount_paid = $2,
            change_given = $3,
            status = $4
      where id = $1
        and status <> 'voided'::sale_status
      returning ${SALE_COLUMNS}`,
    [saleId, input.amountPaid, input.changeGiven, input.status]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapSale(first);
}

/**
 * Marks a sale void, and zeroes the money on it in the same statement.
 *
 * Refuses a sale that is already void, by returning no row rather than by throwing:
 * the caller reads `null` as "nothing to void" and answers accordingly. Restoring
 * stock twice for one sale is the failure this prevents, and it is prevented in the
 * same statement that writes the status so there is no window between the check and
 * the write.
 *
 * ## Why the money is zeroed here and not by `updateSaleSettlement`
 *
 * That statement is guarded `and status <> 'voided'`, and so is this one. Two
 * statements both guarded on "not yet void" cannot both be the one that makes it
 * void, so whichever ran second would find no row and the void would be half
 * applied — stock restored, tenders reversed, and the sale still showing GHS 12.00
 * taken. One statement, one guard, one answer.
 *
 * Zeroing is not a loss of record. Each tender keeps its own `amount` and moves to
 * `reversed`, so the receipt still reads "GHS 12.00 cash taken, GHS 12.00 given
 * back"; what the sale row stops claiming is that any of it is takings. A day's
 * takings is `sum(amount_paid)`, and a report that has to remember to exclude
 * voided sales is a report that overstates the drawer the first time somebody
 * writes it without the filter.
 */
export async function markSaleVoided(
  sql: Sql,
  saleId: string,
  input: { reason: string; voidedAt: string }
): Promise<SaleRow | null> {
  const result = await sql.query(
    `update sales
        set status = 'voided'::sale_status,
            void_reason = $2,
            voided_at = $3,
            amount_paid = 0,
            change_given = 0
      where id = $1
        and status <> 'voided'::sale_status
      returning ${SALE_COLUMNS}`,
    [saleId, input.reason, input.voidedAt]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapSale(first);
}

export async function findSalePayment(
  sql: Sql,
  pharmacyId: string,
  paymentId: string
): Promise<(SalePaymentRow & { pharmacyId: string; saleStatus: SaleStatus }) | null> {
  const result = await sql.query(
    `select sp.id, sp.sale_id, sp.method, sp.status, sp.amount, sp.reference,
            sp.gateway_response, sp.paid_at, sp.created_at, sp.updated_at,
            s.pharmacy_id, s.status as sale_status
       from sale_payments sp
       join sales s on s.id = sp.sale_id
      where s.pharmacy_id = $1 and sp.id = $2`,
    [pharmacyId, paymentId]
  );
  const first = result.rows[0];
  if (first === undefined) return null;
  return {
    ...mapSalePayment(first),
    pharmacyId: first.pharmacy_id as string,
    saleStatus: first.sale_status as SaleStatus,
  };
}

/**
 * The tender a webhook is about.
 *
 * Not scoped by pharmacy, and this is the one lookup in the file that is not: a
 * webhook arrives from Paystack, which knows the merchant account and has never
 * heard of a tenant, so the reference is all there is to go on. The row brings
 * its own `pharmacy_id` back with it, so every decision made from here on is
 * scoped as usual.
 *
 * Restricted to `momo`. `sale_payments.reference` is also where an operator's
 * note goes on a cash tender, and a note is free text — so without this a till
 * that typed a receipt number into a cash note could match a webhook meant for a
 * wallet charge. Only a mobile money tender has a gateway reference at all.
 *
 * `order by created_at, id limit 1` takes the earliest match. Two tenders sharing
 * one gateway reference would mean two charges bound to one id, which the
 * reference's construction prevents and nothing in this build can produce; if it
 * ever happened, the earlier row is the one the reference was minted for.
 *
 * `$1` is compared against `sp.reference`, a `text` column, so it needs no cast.
 * The `method` side is a literal against an enum column — both sides known
 * types, and no parameter involved.
 */
export async function findSalePaymentByReference(
  sql: Sql,
  reference: string
): Promise<(SalePaymentRow & { pharmacyId: string; saleStatus: SaleStatus }) | null> {
  const result = await sql.query(
    `select sp.id, sp.sale_id, sp.method, sp.status, sp.amount, sp.reference,
            sp.gateway_response, sp.paid_at, sp.created_at, sp.updated_at,
            s.pharmacy_id, s.status as sale_status
       from sale_payments sp
       join sales s on s.id = sp.sale_id
      where sp.reference = $1
        and sp.method = 'momo'
      order by sp.created_at, sp.id
      limit 1`,
    [reference]
  );
  const first = result.rows[0];
  if (first === undefined) return null;
  return {
    ...mapSalePayment(first),
    pharmacyId: first.pharmacy_id as string,
    saleStatus: first.sale_status as SaleStatus,
  };
}

/**
 * Moves a tender to a terminal state.
 *
 * Guarded on the current status in the `where` clause rather than read-then-write,
 * because a Paystack webhook and a `verify` call can arrive for the same payment
 * within a second of each other and both are entitled to think they are first. The
 * first one through sets the status; the second finds no row matching and reports
 * that nothing changed, which is the truth. A payment that succeeded and is later
 * re-marked `pending` by a delayed webhook would undo a settlement.
 *
 * ## Why `reference` is not one of the things this can set
 *
 * It was, and it should not have been. `sale_payments.reference` on a mobile
 * money tender is the only thing a webhook has to find that tender with —
 * Paystack knows the merchant account and has never heard of a tenant, so a
 * `charge.success` arrives carrying a reference and nothing else. A statement
 * that can rewrite it can orphan every later webhook for the same charge, and
 * the rewrite would come from a value read out of a third party's payload. The
 * reference is written once, by `insertSalePayment`, from a value minted in
 * `sales.service.ts`; what the gateway said belongs in `gateway_response`, which
 * is a `jsonb` column that exists to hold exactly that, verbatim.
 *
 * The enum parameter in the `where` clause is the load-bearing shape this file is
 * watching for: a parameter on one side of a comparison against an enum column,
 * with no literal to give it a type. It is cast, and the guard list beside it is
 * cast once as an array, so both sides of both comparisons have a declared type.
 * Its placeholder *number* is not worth writing down, because the `set` list is
 * assembled from whichever optionals the caller supplied and the position moves
 * with them — a doc naming `$4` here would be a lie the first time an optional
 * was left out.
 */
export async function updateSalePaymentStatus(
  sql: Sql,
  paymentId: string,
  input: {
    status: SalePaymentStatus;
    gatewayResponse?: unknown;
    paidAt?: string | null;
    /** Statuses the payment may be in for this update to apply. */
    allowedFrom: readonly SalePaymentStatus[];
  }
): Promise<SalePaymentRow | null> {
  const sets = ['status = $2::sale_payment_status'];
  const values: unknown[] = [paymentId, input.status];
  const push = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (input.gatewayResponse !== undefined) {
    sets.push(
      `gateway_response = ${push(
        input.gatewayResponse === null ? null : JSON.stringify(input.gatewayResponse)
      )}::jsonb`
    );
  }
  if (input.paidAt !== undefined) sets.push(`paid_at = ${push(input.paidAt)}`);

  const from = push([...input.allowedFrom]);

  const result = await sql.query(
    `update sale_payments
        set ${sets.join(', ')}
      where id = $1
        and status = any(${from}::sale_payment_status[])
      returning ${SALE_PAYMENT_COLUMNS}`,
    values
  );
  const first = result.rows[0];
  return first === undefined ? null : mapSalePayment(first);
}
