import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Sql } from '../database/pool';
import {
  findSaleByClientSaleId,
  findSaleById,
  findSalePayment,
  findSalePaymentByReference,
  insertSale,
  insertSaleItem,
  insertSaleItemBatch,
  insertSalePayment,
  listSaleItemBatches,
  listSaleItems,
  listSalePayments,
  listSales,
  lockSale,
  markSaleVoided,
  nextSaleNumber,
  patientExists,
  updateSalePaymentStatus,
  updateSaleSettlement,
  type NewSale,
  type NewSaleItem,
  type NewSalePayment,
  type SaleFilters,
} from '../repositories/sales.repository';
import { HttpError } from '../utils/http';

/**
 * The SQL the sales repository emits.
 *
 * Every other suite that touches a sale mocks this module — `sales.routes.test.ts`
 * mocks it to test the till over HTTP, `paystack.service.test.ts` mocks it to test
 * the gateway — so this is the only place the statements themselves are pinned. It
 * exists for one failure above the others: BRIEF.md's landmine 1, the untyped enum
 * parameter, lives in this file and nowhere else. It is a parse-time rejection in
 * Postgres, which means it compiles, it passes every mocked suite, and it turns
 * every sale in the pharmacy into a bare 500 that reads like a gateway outage. Two
 * scans below look for it directly, because a cast that is merely present in a
 * pinned string is a cast somebody can delete while tidying.
 *
 * Like `inventory.repository.test.ts` there is no `jest.mock` of the pool here.
 * Every function takes a `Sql`, because a sale is seven writes that must all land
 * or none and an optional trailing client would let a caller forget it — so a
 * recording stub is the whole harness and there is no module boundary to fake.
 *
 * This proves construction, not execution. That the statements parse against the
 * real schema, and that the seven of them move stock through the trigger chain and
 * give it back on a void, is section 13 of `database/tests/assertions.sql`. The
 * last describe block here is the tie between the two, in both directions.
 */

interface Call {
  text: string;
  params: unknown[];
}

/** Collapses whitespace, so a reformat is not a failure but a rewrite is. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const STAMP = new Date('2026-09-04T09:12:00.000Z');
const STAMP_ISO = '2026-09-04T09:12:00.000Z';

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST = 'a0000000-0000-4000-8000-000000000003';
const PRODUCT = 'a0000000-0000-4000-8000-000000000010';
const BATCH = 'a0000000-0000-4000-8000-000000000012';
const SALE = 'a0000000-0000-4000-8000-000000000020';
const ITEM = 'a0000000-0000-4000-8000-000000000021';
const PAYMENT = 'a0000000-0000-4000-8000-000000000050';
const PATIENT = 'a0000000-0000-4000-8000-000000000060';
const CLIENT_SALE_ID = 'till-7f3c1b90-4d2e';
const SALE_NUMBER = 'S-000042';

/**
 * One row wide enough for every mapper in the repository.
 *
 * `status` is the one collision and it is unavoidable: `mapSale` reads it as the
 * sale's status and `mapSalePayment` reads the same column name as the tender's,
 * because both tables have one and the select lists are unqualified. The default
 * below is the sale's, and every payment-mapping test overrides it — which is
 * itself worth knowing, since a mapper reading the wrong `status` is a receipt
 * that says a pending wallet charge was taken.
 */
function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // sales
    id: SALE,
    pharmacy_id: PHARMACY,
    sale_number: SALE_NUMBER,
    status: 'completed',
    served_by: OWNER,
    approved_by: PHARMACIST,
    patient_id: PATIENT,
    subtotal: '25.00',
    discount: '0.00',
    discount_reason: 'Loyal customer',
    vat_amount: '3.75',
    nhil_amount: '0.63',
    getfund_amount: '0.63',
    tax_total: '5.01',
    total: '30.01',
    amount_paid: '30.01',
    change_given: '0.00',
    vat_rate: '0.1500',
    nhil_rate: '0.0250',
    getfund_rate: '0.0250',
    tax_inclusive_pricing: false,
    client_sale_id: CLIENT_SALE_ID,
    voided_at: null,
    void_reason: null,
    // sale_items
    sale_id: SALE,
    inventory_id: PRODUCT,
    description: 'Paracetamol 500mg',
    sell_unit: 'single',
    quantity: 2,
    unit_price: '12.50',
    line_gross: '25.00',
    line_discount: '0.00',
    taxable_base: '25.00',
    line_total: '30.01',
    vat_treatment: 'standard',
    // sale_item_batches
    sale_item_id: ITEM,
    batch_id: BATCH,
    lot_number: 'LOT-1',
    unit_cost: '8.2500',
    // sale_payments
    method: 'momo',
    amount: '30.01',
    reference: `${SALE_NUMBER}-5F31FF86B4FFB8B2`,
    gateway_response: { status: 'success' },
    paid_at: STAMP,
    // joins and aggregates
    sale_status: 'pending',
    served_by_name: 'Beatrice Owusu',
    patient_name: 'Kofi Asare',
    item_count: '2',
    payment_methods: ['cash', 'momo'],
    last_number: '41',
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

/**
 * Scripted outcomes, consumed in order.
 *
 * One implementation records every call and then decides what to answer, rather
 * than `mockResolvedValueOnce` replacing it: a replacement would skip the
 * recording and leave the assertions looking at an empty list.
 */
type Outcome = { rows: Record<string, unknown>[] } | { error: unknown };

interface Recorder {
  sql: Sql;
  calls: Call[];
  queueRows: (rows: Record<string, unknown>[]) => void;
  queueError: (error: unknown) => void;
  alwaysEmpty: () => void;
}

function recorder(): Recorder {
  const calls: Call[] = [];
  const scripted: Outcome[] = [];
  let fallback: Record<string, unknown>[] = [fakeRow()];

  const sql: Sql = {
    query<T extends QueryResultRow>(
      text: string,
      values?: readonly unknown[]
    ): Promise<QueryResult<T>> {
      calls.push({ text: normalise(text), params: [...(values ?? [])] });

      const outcome = scripted.shift();
      if (outcome !== undefined && 'error' in outcome) {
        return Promise.reject(outcome.error);
      }
      const rows = outcome !== undefined ? outcome.rows : fallback;
      return Promise.resolve({
        rows: rows as unknown as T[],
        rowCount: rows.length,
        oid: 0,
        fields: [],
        command: '',
      });
    },
  };

  return {
    sql,
    calls,
    queueRows: (rows) => scripted.push({ rows }),
    queueError: (error) => scripted.push({ error }),
    alwaysEmpty: () => {
      fallback = [];
    },
  };
}

/**
 * Queues the answer to `nextSaleNumber`, behind the empty result the advisory
 * lock returns in front of it.
 *
 * The lock is a statement, so it consumes an outcome from the same queue as the
 * select that follows. Queued without this, the scripted row lands on the lock
 * and the select falls back to the suite-wide default — which is how five of
 * these tests came to answer `S-000042` whatever they queued, and how a sixth
 * passed for a reason it did not have: the `'41'` it scripted and the `'41'` in
 * the default row were the same value, so nothing distinguished them.
 */
function queueSequence(
  queueRows: Recorder['queueRows'],
  row: Record<string, unknown>
): void {
  queueRows([]);
  queueRows([row]);
}

/** One call, or a failure naming how many there were: an index of 0 is a guess. */
function onlyCall(calls: Call[]): Call {
  if (calls.length !== 1) {
    throw new Error(`expected exactly one statement, recorded ${calls.length}`);
  }
  const call = calls[0];
  if (call === undefined) throw new Error('unreachable: calls.length was 1');
  return call;
}

/**
 * Everything after the first `where`, which is where comparisons live.
 *
 * The enum-cast scan below reads this rather than the whole statement, and the
 * split is what keeps it from firing on assignments: `set status = $4` is a
 * column being written and needs no cast, because the column supplies the type,
 * while `where status = $2` is a comparison the parser has to resolve between
 * two unknowns. Scanning the two together would either drown in false positives
 * or be narrowed until it missed the real thing.
 */
function afterWhere(text: string): string {
  const parts = text.split(' where ');
  return parts.slice(1).join(' where ');
}

const NEW_SALE: NewSale = {
  pharmacyId: PHARMACY,
  saleNumber: SALE_NUMBER,
  status: 'completed',
  servedBy: OWNER,
  approvedBy: PHARMACIST,
  patientId: PATIENT,
  subtotal: '25.00',
  discount: '0.00',
  discountReason: 'Loyal customer',
  vatAmount: '3.75',
  nhilAmount: '0.63',
  getfundAmount: '0.63',
  taxTotal: '5.01',
  total: '30.01',
  amountPaid: '30.01',
  changeGiven: '0.00',
  vatRate: '0.1500',
  nhilRate: '0.0250',
  getfundRate: '0.0250',
  taxInclusivePricing: false,
  clientSaleId: CLIENT_SALE_ID,
};

const NEW_ITEM: NewSaleItem = {
  saleId: SALE,
  inventoryId: PRODUCT,
  description: 'Paracetamol 500mg',
  sellUnit: 'single',
  quantity: 2,
  unitPrice: '12.50',
  lineGross: '25.00',
  lineDiscount: '0.00',
  taxableBase: '25.00',
  vatAmount: '3.75',
  nhilAmount: '0.63',
  getfundAmount: '0.63',
  lineTotal: '30.01',
  vatTreatment: 'standard',
};

const NEW_PAYMENT: NewSalePayment = {
  saleId: SALE,
  method: 'momo',
  status: 'pending',
  amount: '30.01',
  reference: `${SALE_NUMBER}-5F31FF86B4FFB8B2`,
  gatewayResponse: null,
  paidAt: null,
};

/**
 * Every statement shape the repository can emit, driven once each.
 *
 * One list, shared by three checks: the derived-column scan, the quoted-literal
 * allowlist and the tie to the Postgres harness. `inventory.repository.test.ts`
 * started with two such lists and they drifted, so a guard written against one
 * failed for a reason that had nothing to do with the repository. Two lists that
 * have to agree are one list.
 *
 * The shapes are the ones whose text changes: three `listSales` filter
 * combinations and four `updateSalePaymentStatus` optional combinations, each of
 * which renumbers every placeholder after it, and one of everything else.
 *
 * Twenty-four calls, twenty-four distinct statements: `nextSaleNumber` is two,
 * and every other function is one, with the three `listSales` filter shapes and
 * the four `updateSalePaymentStatus` optional shapes each differing in text.
 */
async function everyStatementShape(): Promise<Call[]> {
  const { sql, calls } = recorder();

  await nextSaleNumber(sql, PHARMACY);
  await insertSale(sql, NEW_SALE);
  await insertSaleItem(sql, NEW_ITEM);
  await insertSaleItemBatch(sql, {
    saleItemId: ITEM,
    batchId: BATCH,
    quantity: 2,
    unitCost: '8.2500',
  });
  await insertSalePayment(sql, { ...NEW_PAYMENT, gatewayResponse: { status: 'success' } });
  await findSaleById(sql, PHARMACY, SALE);
  await findSaleByClientSaleId(sql, PHARMACY, CLIENT_SALE_ID);
  await patientExists(sql, PHARMACY, PATIENT);
  await lockSale(sql, PHARMACY, SALE);
  await listSaleItems(sql, SALE);
  await listSaleItemBatches(sql, SALE);
  await listSalePayments(sql, SALE);
  await listSales(sql, PHARMACY, { limit: 50, offset: 0 });
  await listSales(sql, PHARMACY, { status: 'completed', limit: 50, offset: 0 });
  await listSales(sql, PHARMACY, {
    status: 'pending',
    servedBy: OWNER,
    from: '2026-09-01',
    to: '2026-09-04',
    search: 'S-00',
    limit: 20,
    offset: 40,
  });
  await updateSaleSettlement(sql, SALE, {
    amountPaid: '30.01',
    changeGiven: '0.00',
    status: 'completed',
  });
  await markSaleVoided(sql, SALE, { reason: 'Customer walked out', voidedAt: STAMP_ISO });
  await findSalePayment(sql, PHARMACY, PAYMENT);
  await findSalePaymentByReference(sql, `${SALE_NUMBER}-5F31FF86B4FFB8B2`);
  await updateSalePaymentStatus(sql, PAYMENT, { status: 'succeeded', allowedFrom: ['pending'] });
  await updateSalePaymentStatus(sql, PAYMENT, {
    status: 'succeeded',
    gatewayResponse: { status: 'success' },
    allowedFrom: ['pending'],
  });
  await updateSalePaymentStatus(sql, PAYMENT, {
    status: 'failed',
    paidAt: null,
    allowedFrom: ['pending'],
  });
  await updateSalePaymentStatus(sql, PAYMENT, {
    status: 'succeeded',
    gatewayResponse: { status: 'success' },
    paidAt: STAMP_ISO,
    allowedFrom: ['pending'],
  });

  return calls;
}

// ---------------------------------------------------------------------------
// The receipt number
// ---------------------------------------------------------------------------

describe('nextSaleNumber', () => {
  it('takes a pharmacy-wide advisory lock before it reads the sequence', async () => {
    const { sql, calls } = recorder();

    await nextSaleNumber(sql, PHARMACY);

    // Two statements, and the order is the whole mechanism: `pg_advisory_xact_lock`
    // is held until the transaction ends, so it spans the read of `max()` and the
    // insert that uses it. Called on the pool rather than a client, each statement
    // is its own transaction, the lock is released before the number is used, and
    // two tills ring up the same receipt number.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toBe('select pg_advisory_xact_lock(hashtextextended($1, 0))');
    // Namespaced, so it cannot collide with an advisory lock taken for anything
    // else, and keyed on the pharmacy so one counter's sale never waits on another.
    expect(calls[0]?.params).toEqual([`a-and-b-chemist:sale_number:${PHARMACY}`]);
    expect(calls[1]?.text).toContain(
      'select coalesce(max(substring(sale_number from $2)::bigint), 0) as last_number'
    );
    expect(calls[1]?.text).toContain('where pharmacy_id = $1');
    expect(calls[1]?.params).toEqual([PHARMACY, '^S-([0-9]+)$']);
  });

  it('passes the receipt-number pattern as a parameter rather than into the text', async () => {
    const { sql, calls } = recorder();

    await nextSaleNumber(sql, PHARMACY);

    // The prefix lives in one constant and no part of a statement is built by
    // concatenation. A pattern spliced into the text would work, and would be the
    // first thing in this file that a caller's value could reach.
    const text = calls[1]?.text ?? '';
    expect(text).not.toContain('[0-9]');
    expect(text).not.toContain('S-');
  });

  it('numbers from the highest receipt issued, not from a count of rows', async () => {
    const { sql, queueRows } = recorder();
    queueSequence(queueRows, { last_number: '41' });

    await expect(nextSaleNumber(sql, PHARMACY)).resolves.toBe('S-000042');
  });

  it('starts at S-000001 for a pharmacy that has sold nothing', async () => {
    const { sql, queueRows } = recorder();
    // `coalesce(max(...), 0)` over an empty table, and over a table whose every
    // number fails the pattern — which is what the schema harness leaves behind
    // when it writes rows numbered `HARNESS-SALE-...` and deletes them again. A
    // `count(*)`-based scheme would issue a duplicate the day that ran.
    queueSequence(queueRows, { last_number: null });
    await expect(nextSaleNumber(sql, PHARMACY)).resolves.toBe('S-000001');

    // The second shape is not the same as the first: `null` is SQL's answer and
    // `{}` is a row the driver sent without the column at all. Both have to read
    // as zero, because only one of them can be checked for by name.
    queueSequence(queueRows, {});
    await expect(nextSaleNumber(sql, PHARMACY)).resolves.toBe('S-000001');
  });

  it('reads the bigint as a number, so the next one is incremented and not concatenated', async () => {
    const { sql, queueRows } = recorder();
    // node-pg returns a `bigint` as a string, because it will not put a 64-bit
    // integer into a double it cannot represent exactly. Read as a string,
    // `last + 1` is `'41' + 1` and the receipt book gets `S-0000411`.
    queueSequence(queueRows, { last_number: '7' });

    await expect(nextSaleNumber(sql, PHARMACY)).resolves.toBe('S-000008');
  });

  it('pads to six digits and does not truncate a longer number', async () => {
    const { sql, queueRows } = recorder();
    queueSequence(queueRows, { last_number: '999999' });

    // `padStart` widens and never narrows. Truncating at six would reissue a
    // number the pharmacy has already printed in a paper book.
    await expect(nextSaleNumber(sql, PHARMACY)).resolves.toBe('S-1000000');
  });

  it('refuses a sequence it cannot read rather than guessing at a number', async () => {
    const { sql, queueRows } = recorder();
    queueSequence(queueRows, { last_number: 'not-a-number' });

    await expect(nextSaleNumber(sql, PHARMACY)).rejects.toThrow(
      /unreadable receipt number sequence/
    );
  });

  it('refuses a negative sequence, which no max() over this table can return', async () => {
    const { sql, queueRows } = recorder();
    queueSequence(queueRows, { last_number: '-3' });

    // Unreachable through the statement, and checked anyway: the alternative to
    // throwing is `S-000-2`, a receipt number nobody can read aloud and no
    // unique constraint would ever catch.
    await expect(nextSaleNumber(sql, PHARMACY)).rejects.toThrow(
      /unreadable receipt number sequence/
    );
  });
});

// ---------------------------------------------------------------------------
// The seven writes
// ---------------------------------------------------------------------------

describe('insertSale', () => {
  it('writes twenty-one parameters in column order and casts the enum', async () => {
    const { sql, calls } = recorder();

    await insertSale(sql, NEW_SALE);

    const { text, params } = onlyCall(calls);
    // The exact list, in order. This is the assertion that catches a placeholder
    // numbered one out: the statement would still parse, still run, and would put
    // the discount in the vat column — a receipt whose tax does not add up, found
    // by an auditor rather than by a test.
    expect(params).toEqual([
      PHARMACY,
      SALE_NUMBER,
      'completed',
      OWNER,
      PHARMACIST,
      PATIENT,
      '25.00',
      '0.00',
      'Loyal customer',
      '3.75',
      '0.63',
      '0.63',
      '5.01',
      '30.01',
      '30.01',
      '0.00',
      '0.1500',
      '0.0250',
      '0.0250',
      false,
      CLIENT_SALE_ID,
    ]);
    expect(text).toContain(
      'values ($1, $2, $3::sale_status, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)'
    );
    // The four tax snapshot columns are NOT NULL with no default, so a sale
    // cannot be stored without the rates it charged. ASSERT 8f guards the schema
    // half of that; this is the statement half.
    expect(text).toContain('vat_rate, nhil_rate, getfund_rate,');
    expect(text).toContain('tax_inclusive_pricing, client_sale_id)');
  });

  it('maps every column of the row it wrote', async () => {
    const { sql } = recorder();

    await expect(insertSale(sql, NEW_SALE)).resolves.toEqual({
      id: SALE,
      pharmacyId: PHARMACY,
      saleNumber: SALE_NUMBER,
      status: 'completed',
      servedBy: OWNER,
      approvedBy: PHARMACIST,
      patientId: PATIENT,
      subtotal: '25.00',
      discount: '0.00',
      discountReason: 'Loyal customer',
      vatAmount: '3.75',
      nhilAmount: '0.63',
      getfundAmount: '0.63',
      taxTotal: '5.01',
      total: '30.01',
      amountPaid: '30.01',
      changeGiven: '0.00',
      vatRate: '0.1500',
      nhilRate: '0.0250',
      getfundRate: '0.0250',
      taxInclusivePricing: false,
      clientSaleId: CLIENT_SALE_ID,
      voidedAt: null,
      voidReason: null,
      createdAt: STAMP_ISO,
      updatedAt: STAMP_ISO,
    });
  });

  it('leaves a numeric column as the string the driver returned', async () => {
    const { sql } = recorder();

    const sale = await insertSale(sql, NEW_SALE);

    // Never a double, on any of the eleven money columns. A till that adds money
    // in doubles is a pesewa out on some totals and a drawer that never reconciles.
    for (const value of [
      sale.subtotal,
      sale.discount,
      sale.vatAmount,
      sale.nhilAmount,
      sale.getfundAmount,
      sale.taxTotal,
      sale.total,
      sale.amountPaid,
      sale.changeGiven,
      sale.vatRate,
      sale.nhilRate,
      sale.getfundRate,
    ]) {
      expect(typeof value).toBe('string');
    }
  });

  it('turns a duplicate clientSaleId into the 409 the idempotency path answers with', async () => {
    const { sql, queueError } = recorder();
    queueError({ code: '23505', constraint: 'sales_client_sale_id_key' });

    // Not an error at all, in the till's reading of it: the client retried a sale
    // whose response it never received, and the answer is the sale that already
    // exists. `createSale` catches this code and goes and fetches it.
    await expect(insertSale(sql, NEW_SALE)).rejects.toMatchObject({
      status: 409,
      code: 'sale_already_recorded',
    });
  });

  it('turns a duplicate receipt number into a different 409, because it means a different thing', async () => {
    const { sql, queueError } = recorder();
    queueError({ code: '23505', constraint: 'sales_pharmacy_id_sale_number_key' });

    // Same Postgres error code, opposite meaning. This one is a bug in the
    // numbering — the advisory lock was not held across the read — and the fix is
    // to try the sale again, not to hand back somebody else's receipt.
    await expect(insertSale(sql, NEW_SALE)).rejects.toMatchObject({
      status: 409,
      code: 'sale_number_taken',
    });
  });

  it('leaves every other fault exactly as it arrived', async () => {
    const { sql, queueError } = recorder();
    const fault = new Error('connection terminated unexpectedly');
    queueError(fault);

    // Wrapped faults are how a real outage becomes a 409 the till will not retry.
    await expect(insertSale(sql, NEW_SALE)).rejects.toBe(fault);

    // And a 23505 from a constraint this function does not know is not a replay.
    queueError({ code: '23505', constraint: 'some_other_key' });
    await expect(insertSale(sql, NEW_SALE)).rejects.not.toBeInstanceOf(HttpError);
  });

  it('throws rather than mapping nothing when the insert returns no row', async () => {
    const { sql, alwaysEmpty } = recorder();
    alwaysEmpty();

    // Unreachable — an INSERT ... RETURNING that writes a row returns it — and
    // thrown rather than papered over, because `mapSale(undefined)` would be a
    // receipt with every field undefined and a 201 to say it went through.
    await expect(insertSale(sql, NEW_SALE)).rejects.toThrow(/returned no row/);
  });
});

describe('insertSaleItem', () => {
  it('assigns both enums without casting either', async () => {
    const { sql, calls } = recorder();

    await insertSaleItem(sql, NEW_ITEM);

    const { text, params } = onlyCall(calls);
    expect(params).toEqual([
      SALE,
      PRODUCT,
      'Paracetamol 500mg',
      'single',
      2,
      '12.50',
      '25.00',
      '0.00',
      '25.00',
      '3.75',
      '0.63',
      '0.63',
      '30.01',
      'standard',
    ]);
    expect(text).toContain('values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)');
    // `$4` is `sell_unit` and `$14` is `vat_treatment`, and neither is cast,
    // because neither is compared against anything: the column supplies the type.
    // Left uncast on purpose so that the casts in this file keep meaning
    // something — a cast on every enum parameter everywhere is a cast nobody
    // reads, and the load-bearing one stops being findable.
    expect(text).not.toContain('$4::');
    expect(text).not.toContain('$14::');
  });

  it('snapshots the description rather than reading the product back', async () => {
    const { sql, calls } = recorder();

    await insertSaleItem(sql, NEW_ITEM);

    // Renaming a product must not rewrite a receipt that was printed and handed to
    // a customer. The name travels as a value on the line, so there is no join
    // here for a later rename to be read through.
    const { text, params } = onlyCall(calls);
    expect(text).not.toContain('join');
    expect(params).toContain('Paracetamol 500mg');
  });
});

describe('insertSaleItemBatch', () => {
  it('records base units against the lot, and returns nothing', async () => {
    const { sql, calls } = recorder();

    await expect(
      insertSaleItemBatch(sql, { saleItemId: ITEM, batchId: BATCH, quantity: 20, unitCost: '8.2500' })
    ).resolves.toBeUndefined();

    const { text, params } = onlyCall(calls);
    expect(params).toEqual([ITEM, BATCH, 20, '8.2500']);
    expect(text).toBe(
      'insert into sale_item_batches (sale_item_id, batch_id, quantity, unit_cost) values ($1, $2, $3, $4)'
    );
  });

  it('is the row that makes a void safe and a recall answerable', async () => {
    const { sql, calls } = recorder();

    await insertSaleItemBatch(sql, {
      saleItemId: ITEM,
      batchId: BATCH,
      quantity: 20,
      unitCost: '8.2500',
    });

    // The batch is named by id, so a void restores to the lot the units actually
    // came from rather than to a product total that
    // `recompute_inventory_from_batches` overwrites on the next write. And
    // `recallTrace` in the inventory repository reads this junction, which is the
    // only way "who bought LOT-1" has an answer.
    expect(onlyCall(calls).text).toContain('batch_id');
    expect(onlyCall(calls).text).toContain('unit_cost');
  });
});

describe('insertSalePayment', () => {
  it('serialises the gateway payload, and leaves a null one null', async () => {
    const { sql, calls } = recorder();

    await insertSalePayment(sql, { ...NEW_PAYMENT, gatewayResponse: { status: 'success' } });
    await insertSalePayment(sql, NEW_PAYMENT);

    expect(calls).toHaveLength(2);
    // `jsonb` from JavaScript needs a string or an object; a nested object bound
    // directly is sent as `[object Object]` by some drivers and as JSON by others.
    // Serialising here makes it one thing.
    expect(calls[0]?.params[5]).toBe('{"status":"success"}');
    // And null stays null rather than becoming the four-character string "null",
    // which is a jsonb value that reads as truthy to every query that checks
    // `gateway_response is null`.
    expect(calls[1]?.params[5]).toBeNull();
    expect(calls[0]?.params).toEqual([
      SALE,
      'momo',
      'pending',
      '30.01',
      `${SALE_NUMBER}-5F31FF86B4FFB8B2`,
      '{"status":"success"}',
      null,
    ]);
  });

  it('assigns method and status without casting either', async () => {
    const { sql, calls } = recorder();

    await insertSalePayment(sql, NEW_PAYMENT);

    const text = onlyCall(calls).text;
    expect(text).toContain('values ($1, $2, $3, $4, $5, $6, $7)');
    expect(text).not.toContain('::sale_payment_method');
    expect(text).not.toContain('::sale_payment_status');
  });

  it('maps the tender from its own status column', async () => {
    const { sql, queueRows } = recorder();
    // The header's `status` collision made concrete. One row comes back with one
    // `status` column, and which mapper reads it decides whether the receipt
    // says the wallet charge settled or that the sale did — so the row is queued
    // rather than left to the default, which carries the sale's value.
    queueRows([fakeRow({ status: 'succeeded' })]);

    await expect(
      insertSalePayment(sql, { ...NEW_PAYMENT, status: 'succeeded', paidAt: STAMP_ISO })
    ).resolves.toEqual({
      id: SALE,
      saleId: SALE,
      method: 'momo',
      status: 'succeeded',
      amount: '30.01',
      reference: `${SALE_NUMBER}-5F31FF86B4FFB8B2`,
      // `jsonb` arrives already parsed, so it leaves as the object the gateway
      // sent rather than as the string this file wrote.
      gatewayResponse: { status: 'success' },
      paidAt: STAMP_ISO,
      createdAt: STAMP_ISO,
      updatedAt: STAMP_ISO,
    });
  });
});

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

describe('the reads', () => {
  it('scopes every sale lookup by pharmacy, including the patient check', async () => {
    const { sql, calls } = recorder();

    await findSaleById(sql, PHARMACY, SALE);
    await findSaleByClientSaleId(sql, PHARMACY, CLIENT_SALE_ID);
    await lockSale(sql, PHARMACY, SALE);
    await patientExists(sql, PHARMACY, PATIENT);
    await findSalePayment(sql, PHARMACY, PAYMENT);

    // `id` is a primary key, so the scope is not what finds the row: it is what
    // stops a uuid belonging to somebody else answering here. Single-tenant
    // today, and the day this is copied into a multi-tenant build is the day a
    // missing scope stops being a no-op and becomes a disclosure.
    for (const call of calls) {
      expect(call.text).toContain('pharmacy_id = $1');
      expect(call.params[0]).toBe(PHARMACY);
    }

    // The patient check is the one that would be easiest to lose, because it is
    // a `select 1` with no mapper and no row to point at. It is also the one
    // with the sharpest reason: a sale naming another pharmacy's patient must be
    // indistinguishable from a sale naming nobody, and "no such patient" is the
    // only honest answer to give either way.
    expect(calls).toHaveLength(5);
    expect(calls[3]?.text).toBe('select 1 from patients where pharmacy_id = $1 and id = $2');
  });

  it('locks the row on the read that decides, and not on the read that answers', async () => {
    const { sql, calls } = recorder();

    await lockSale(sql, PHARMACY, SALE);
    await findSaleById(sql, PHARMACY, SALE);

    const locked = calls[0];
    const plain = calls[1];
    if (locked === undefined || plain === undefined) {
      throw new Error(`expected two statements, recorded ${calls.length}`);
    }

    // A void and a payment both read the sale, decide from what they read, and
    // write it back. Without the lock two of them interleave and the second
    // overwrites a settlement the first had already completed.
    expect(locked.text).toMatch(/for update$/u);
    expect(plain.text).not.toContain('for update');
    // And the two are otherwise the same statement, which is the part the regex
    // above cannot see: a lock added to a *different* select — one reading fewer
    // columns, or joining — would satisfy it while locking a row the write path
    // never compared against.
    expect(locked.text.replace(' for update', '')).toBe(plain.text);
  });

  it('answers null rather than undefined when a row is not there', async () => {
    const { sql, alwaysEmpty } = recorder();
    alwaysEmpty();

    // `undefined` and `null` are not interchangeable on the way out: one
    // serialises as an absent key and the other as a null one, so "no such sale"
    // and "this sale has no void reason" would be the same response body. Every
    // read that can miss is checked rather than a sample of them, because the
    // one left out is the one a caller writes `?? ` around.
    await expect(findSaleById(sql, PHARMACY, SALE)).resolves.toBeNull();
    await expect(findSaleByClientSaleId(sql, PHARMACY, CLIENT_SALE_ID)).resolves.toBeNull();
    await expect(lockSale(sql, PHARMACY, SALE)).resolves.toBeNull();
    await expect(findSalePayment(sql, PHARMACY, PAYMENT)).resolves.toBeNull();
    await expect(findSalePaymentByReference(sql, 'S-000042-0')).resolves.toBeNull();

    // These three answer null for a reason that is not "not found": each is
    // guarded, and a guard that matched no row is the statement saying the sale
    // was already voided or the tender already terminal. The caller reads that
    // as "nothing changed", which is the truth and not an error.
    await expect(
      updateSaleSettlement(sql, SALE, {
        amountPaid: '0.00',
        changeGiven: '0.00',
        status: 'completed',
      })
    ).resolves.toBeNull();
    await expect(
      markSaleVoided(sql, SALE, { reason: 'Twice', voidedAt: STAMP_ISO })
    ).resolves.toBeNull();
    await expect(
      updateSalePaymentStatus(sql, PAYMENT, { status: 'succeeded', allowedFrom: ['pending'] })
    ).resolves.toBeNull();

    await expect(patientExists(sql, PHARMACY, PATIENT)).resolves.toBe(false);
    await expect(listSaleItems(sql, SALE)).resolves.toEqual([]);
    await expect(listSaleItemBatches(sql, SALE)).resolves.toEqual([]);
    await expect(listSalePayments(sql, SALE)).resolves.toEqual([]);
    await expect(listSales(sql, PHARMACY, { limit: 50, offset: 0 })).resolves.toEqual([]);
  });

  it('reads the lot junction through the line and the batch, in the order units were taken', async () => {
    const { sql, calls } = recorder();

    const rows = await listSaleItemBatches(sql, SALE);

    const text = onlyCall(calls).text;
    // Through `sale_items` because the junction hangs off the line and the caller
    // asks by sale; through `inventory_batches` for the lot number, which is the
    // thing a recall is spoken in at a counter.
    expect(text).toContain('join sale_items si on si.id = sib.sale_item_id');
    expect(text).toContain('join inventory_batches b on b.id = sib.batch_id');
    // Ordered by line so a void restores in the order the units left and the
    // ledger reads the same forwards and backwards. `sib.id` is last because two
    // draws from one batch on one line would otherwise be free to swap between
    // reads, and a restore that runs in a different order from the draw is one
    // nobody can reconcile against the paper ledger.
    expect(text).toContain('order by si.created_at, si.id, sib.id');
    expect(onlyCall(calls).params).toEqual([SALE]);

    expect(rows).toEqual([
      {
        id: SALE,
        saleItemId: ITEM,
        batchId: BATCH,
        lotNumber: 'LOT-1',
        // Base units, not the selling units on the receipt. Two strips of ten is
        // a line quantity of 2 and a junction total of 20, and it is the
        // junction a recall reads.
        quantity: 2,
        unitCost: '8.2500',
        // Carried from the line because the void restores stock to a product and
        // the junction does not name one. Without it the caller would have to
        // read every line back to find out which product a lot belonged to.
        inventoryId: PRODUCT,
      },
    ]);
  });

  it('orders the lines and the tenders, so a receipt is the same every time it is read', async () => {
    const { sql, calls } = recorder();

    await listSaleItems(sql, SALE);
    await listSalePayments(sql, SALE);

    // Both end in `id`, and that is what makes the order total: `created_at`
    // alone ties for rows written inside one transaction, and Postgres may
    // return ties in any order it likes. A receipt whose lines swap between two
    // reads of the same sale is one a pharmacist cannot compare against the
    // printed copy, which is the only comparison anybody ever makes.
    expect(calls[0]?.text).toContain('order by created_at, id');
    expect(calls[1]?.text).toContain('order by created_at, id');
  });
});

// ---------------------------------------------------------------------------
// The history list
// ---------------------------------------------------------------------------

/** Placeholder numbers used by a statement, in the order they appear. */
function placeholders(text: string): number[] {
  return [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1] ?? 0));
}

describe('listSales', () => {
  /**
   * Every filter combination, and the exact parameter list each produces.
   *
   * The `push()` closure numbers a placeholder from the length of the value
   * list at the moment it is called, so a filter added to the WHERE without a
   * matching push — or pushed twice — leaves a gap or a repeat that Postgres
   * reports at parse time as `there is no parameter $n`. Each combination
   * renumbers every placeholder after it, which is why this is a table and not
   * one test with one shape.
   */
  const combinations: Array<{ name: string; filters: SaleFilters; expected: unknown[] }> = [
    { name: 'no filters', filters: { limit: 50, offset: 0 }, expected: [PHARMACY, 50, 0] },
    {
      name: 'status',
      filters: { status: 'completed', limit: 50, offset: 0 },
      expected: [PHARMACY, 'completed', 50, 0],
    },
    {
      name: 'served by',
      filters: { servedBy: OWNER, limit: 50, offset: 0 },
      expected: [PHARMACY, OWNER, 50, 0],
    },
    {
      name: 'date range',
      filters: { from: '2026-09-01', to: '2026-09-04', limit: 50, offset: 0 },
      expected: [PHARMACY, '2026-09-01', '2026-09-04', 50, 0],
    },
    {
      name: 'search',
      filters: { search: 'S-00', limit: 20, offset: 40 },
      expected: [PHARMACY, '%S-00%', 20, 40],
    },
    {
      name: 'everything',
      filters: {
        status: 'pending',
        servedBy: OWNER,
        from: '2026-09-01',
        to: '2026-09-04',
        search: 'S-00',
        limit: 20,
        offset: 40,
      },
      expected: [PHARMACY, 'pending', OWNER, '2026-09-01', '2026-09-04', '%S-00%', 20, 40],
    },
  ];

  it('numbers the placeholders 1..n with no gap and no repeat, for every combination', async () => {
    const checked: string[] = [];

    for (const combination of combinations) {
      const { sql, calls } = recorder();
      await listSales(sql, PHARMACY, combination.filters);

      const call = onlyCall(calls);
      expect(placeholders(call.text)).toEqual(call.params.map((_value, index) => index + 1));
      expect(call.params).toEqual(combination.expected);
      checked.push(combination.name);
    }

    // Guarding the guard: an empty table passes both assertions above without
    // calling the repository at all, and it is the kind of thing that happens
    // when somebody tidies a fixture into a `filter()`.
    expect(checked).toEqual([
      'no filters',
      'status',
      'served by',
      'date range',
      'search',
      'everything',
    ]);
  });

  it('casts the status filter, and only when there is one', async () => {
    const { sql, calls } = recorder();

    await listSales(sql, PHARMACY, { status: 'completed', limit: 50, offset: 0 });
    await listSales(sql, PHARMACY, { limit: 50, offset: 0 });

    // Load-bearing, and the reason this suite exists. The parameter is used
    // twice: once in `is null`, which supplies no type at all, and once compared
    // against `s.status`. Uncast, the parser resolves it from the comparison
    // today — and the edit somebody makes to let the till send one value meaning
    // "no filter", `or $2 = 'all'`, gives it a second and incompatible
    // deduction. From then on every history request fails at parse time with
    // `inconsistent types deduced for parameter $2`.
    expect(calls[0]?.text).toContain('s.status = $2::sale_status');
    expect(calls[1]?.text).not.toContain('::sale_status');
  });

  it('omits a filter that is null, rather than binding it and matching nothing', async () => {
    const { sql, calls } = recorder();

    await listSales(sql, PHARMACY, {
      status: null,
      from: null,
      to: null,
      servedBy: null,
      search: null,
      limit: 50,
      offset: 0,
    });

    const text = onlyCall(calls).text;
    // An explicit null off the query string means "no filter", not "filter by
    // nothing". Bound, `s.status = null` is NULL for every row, so the history
    // list comes back empty — and an empty list reads as "no sales today"
    // rather than as the bug it is. That is the worst shape a filter bug can
    // take, because the answer is plausible.
    expect(text).toContain('where s.pharmacy_id = $1 order by');
    expect(text).not.toContain('s.status =');
    expect(text).not.toContain('ilike');
    expect(text).not.toContain('s.created_at >=');
    expect(onlyCall(calls).params).toEqual([PHARMACY, 50, 0]);

    // An empty search is omitted too, and separately from a null one: `ilike
    // '%%'` matches every row so it is harmless, but it costs a predicate on
    // every row of a list that is read far more often than it is filtered.
    await listSales(sql, PHARMACY, { search: '', limit: 50, offset: 0 });
    expect(calls[1]?.text).not.toContain('ilike');
  });

  it('widens the closing date to the whole day rather than to its midnight', async () => {
    const { sql, calls } = recorder();

    await listSales(sql, PHARMACY, {
      from: '2026-09-01',
      to: '2026-09-04',
      limit: 50,
      offset: 0,
    });

    const text = onlyCall(calls).text;
    // Compared against `created_at`, a timestamptz, so the opening date is
    // widened to the start of that day rather than compared as text.
    expect(text).toContain('s.created_at >= $2::timestamptz');
    // `created_at <= '2026-09-04'` is midnight at the *start* of the 4th, so a
    // day's takings report run at closing time drops every sale made that day.
    // It is wrong by an amount that looks like a slow day rather than like a
    // bug, and the pharmacist who notices is the one reconciling the drawer.
    expect(text).toContain("s.created_at < ($3::date + interval '1 day')");
    expect(text).not.toContain('<=');
  });

  it('aggregates the tenders instead of joining them into rows', async () => {
    const { sql, calls } = recorder();

    await listSales(sql, PHARMACY, { limit: 50, offset: 0 });

    const text = onlyCall(calls).text;
    // The `::text` is asserted on purpose: without it the column is an array of the
    // `sale_payment_method` enum, an OID `pg` cannot parse, and the driver returns
    // the wire string `"{cash}"` instead of an array — which is a `.map is not a
    // function` crash on the till the first time the list has a sale on it.
    expect(text).toContain('array_agg(sp.method::text order by sp.created_at, sp.id)');
    expect(text).toContain('coalesce(');
    expect(text).toContain("'{}'");
    // A join would repeat the sale once per tender, and `limit 50` would then
    // cut through the middle of one sale's payments: a split-paid sale sitting
    // at the page boundary would show cash on one page and mobile money on the
    // next, and the count of sales on the page would not be fifty.
    expect(text).not.toContain('join sale_payments');
  });

  it('reads the line count as a number and an untendered sale as no methods', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ item_count: '3', payment_methods: null })]);

    const rows = await listSales(sql, PHARMACY, { limit: 50, offset: 0 });

    // `count(*)` is a bigint and node-pg will not put a 64-bit integer into a
    // double it cannot represent exactly, so it arrives as a string. Left as
    // one, the API answers `"itemCount": "3"` and the till renders it happily —
    // until something adds two of them up and gets `"23"`.
    //
    // `array_agg` over no rows is NULL rather than an empty array, so both
    // halves of that default are checked: a dropped `coalesce` in the statement
    // and a dropped `?? []` in the mapper are the same bug from two directions.
    expect(rows).toEqual([
      {
        id: SALE,
        saleNumber: SALE_NUMBER,
        status: 'completed',
        createdAt: STAMP_ISO,
        servedByName: 'Beatrice Owusu',
        patientName: 'Kofi Asare',
        total: '30.01',
        amountPaid: '30.01',
        changeGiven: '0.00',
        itemCount: 3,
        paymentMethods: [],
      },
    ]);
  });

  it('binds the search term, so a receipt number cannot become a statement', async () => {
    const { sql, calls } = recorder();

    await listSales(sql, PHARMACY, { search: "S-1' or '1'='1", limit: 50, offset: 0 });

    const call = onlyCall(calls);
    expect(call.text).not.toContain("'1'='1");
    // The `%` wildcards are added by `likePattern` to the value, not around a
    // hole left in the statement, so the whole term travels as one parameter.
    // `likePattern`'s own escaping of `%`, `_` and `\` is pinned in
    // `inventory.repository.test.ts`; what is pinned here is that the search
    // goes through it at all.
    expect(call.params).toEqual([PHARMACY, "%S-1' or '1'='1%", 50, 0]);
  });
});

// ---------------------------------------------------------------------------
// The three statements that move a sale after it exists
// ---------------------------------------------------------------------------

describe('updateSaleSettlement', () => {
  it('writes the money and the status in one statement, and refuses a voided sale', async () => {
    const { sql, calls } = recorder();

    await updateSaleSettlement(sql, SALE, {
      amountPaid: '30.01',
      changeGiven: '0.00',
      status: 'completed',
    });

    const call = onlyCall(calls);
    expect(call.params).toEqual([SALE, '30.01', '0.00', 'completed']);
    // One fact, one statement: a sale is `completed` exactly when what has been
    // paid covers what is owed. Split across two updates there is a window where
    // the money has arrived and the status has not, and a till polling inside it
    // shows a paid sale as unpaid — which is how a customer is asked to pay
    // twice for one box of tablets.
    expect(call.text).toContain('set amount_paid = $2, change_given = $3, status = $4');
    expect(call.text).toContain("where id = $1 and status <> 'voided'::sale_status");
    // `$4` is assigned, so the column supplies its type and no cast is needed.
    // Pinned negatively on purpose: the instinct after reading landmine 1 is to
    // cast every enum parameter everywhere, and a cast on everything is a cast
    // nobody reads — the two that actually hold this file up would stop being
    // findable by eye.
    expect(call.text).not.toContain('$4::');
  });
});

describe('markSaleVoided', () => {
  it('voids, and zeroes the money on the sale, in the same statement', async () => {
    const { sql, calls } = recorder();

    await markSaleVoided(sql, SALE, { reason: 'Customer walked out', voidedAt: STAMP_ISO });

    const call = onlyCall(calls);
    expect(call.params).toEqual([SALE, 'Customer walked out', STAMP_ISO]);
    expect(call.text).toContain(
      "set status = 'voided'::sale_status, void_reason = $2, voided_at = $3, " +
        'amount_paid = 0, change_given = 0'
    );
    expect(call.text).toContain("where id = $1 and status <> 'voided'::sale_status");
  });

  it('answers null for a sale that is already void, rather than throwing', async () => {
    const { sql, alwaysEmpty } = recorder();
    alwaysEmpty();

    // Null so the caller can say "already voided" without a try/catch, and in
    // the statement rather than in a read before it: restoring stock twice for
    // one sale is the failure this prevents, and a check-then-write leaves the
    // whole of the gap between them for it to happen in.
    await expect(
      markSaleVoided(sql, SALE, { reason: 'Twice', voidedAt: STAMP_ISO })
    ).resolves.toBeNull();
  });

  it('is the only statement that can zero a sale, and the settlement cannot', async () => {
    const { sql, calls } = recorder();

    await markSaleVoided(sql, SALE, { reason: 'Customer walked out', voidedAt: STAMP_ISO });
    await updateSaleSettlement(sql, SALE, {
      amountPaid: '0.00',
      changeGiven: '0.00',
      status: 'voided',
    });

    // Two statements both guarded on "not yet void" cannot both be the one that
    // makes it void, so whichever ran second would find no row and the void would
    // be half applied: stock restored, tenders reversed, and the sale still
    // claiming GHS 30.01 taken. A day's takings is `sum(amount_paid)`, and a
    // report that has to remember to exclude voided sales overstates the drawer
    // the first time somebody writes it without the filter.
    expect(calls[0]?.text).toContain('amount_paid = 0, change_given = 0');
    expect(calls[1]?.text).toContain("and status <> 'voided'::sale_status");
    // Zeroing is not a loss of record. Each tender keeps its own `amount` and
    // moves to `reversed`, so the receipt still reads "GHS 30.01 taken, GHS
    // 30.01 given back"; what the sale row stops claiming is that any of it is
    // takings.
  });
});

// ---------------------------------------------------------------------------
// The tender lookups
// ---------------------------------------------------------------------------

describe('findSalePayment', () => {
  it('brings the sale back with the tender, so a decision can be scoped', async () => {
    const { sql, calls, queueRows } = recorder();
    // `status` appears twice in this row and means two different things: the
    // tender's own, and the sale's under an alias. The header's collision is not
    // theoretical — a mapper reading the wrong one produces a receipt that says a
    // wallet charge was taken when it was the sale that completed.
    queueRows([fakeRow({ status: 'succeeded' })]);

    const payment = await findSalePayment(sql, PHARMACY, PAYMENT);

    const text = onlyCall(calls).text;
    expect(text).toContain('join sales s on s.id = sp.sale_id');
    expect(text).toContain('s.pharmacy_id, s.status as sale_status');
    expect(text).toContain('where s.pharmacy_id = $1 and sp.id = $2');

    // The verify path needs the sale's status and not only the tender's: a
    // wallet charge that succeeds against a sale somebody has already voided
    // must be handed back, not settled. Reading both here is one statement
    // instead of two, and two would not be reading the same row unless both were
    // taken under a lock.
    expect(payment).toEqual({
      id: SALE,
      saleId: SALE,
      method: 'momo',
      status: 'succeeded',
      amount: '30.01',
      reference: `${SALE_NUMBER}-5F31FF86B4FFB8B2`,
      gatewayResponse: { status: 'success' },
      paidAt: STAMP_ISO,
      createdAt: STAMP_ISO,
      updatedAt: STAMP_ISO,
      pharmacyId: PHARMACY,
      saleStatus: 'pending',
    });
  });
});

describe('findSalePaymentByReference', () => {
  it('is the one lookup in this file not scoped by pharmacy', async () => {
    const { sql, calls } = recorder();

    await findSalePaymentByReference(sql, `${SALE_NUMBER}-5F31FF86B4FFB8B2`);

    const call = onlyCall(calls);
    expect(call.text).toContain('where sp.reference = $1');
    expect(call.text).not.toContain('pharmacy_id = $1');
    // A webhook arrives from Paystack, which knows the merchant account and has
    // never heard of a tenant, so the reference is all there is to go on. The row
    // brings its own pharmacy back with it, which is what makes the missing scope
    // safe rather than merely unavoidable: every decision made after this point
    // is scoped as usual.
    expect(call.text).toContain('s.pharmacy_id, s.status as sale_status');
    // Restricted to momo, and this is a real hazard rather than a tidy one. On a
    // cash tender `reference` holds the operator's free-text note for drawer
    // reconciliation, so without the restriction a till that typed a receipt
    // number into a cash note could match a webhook meant for a wallet charge —
    // and would then mark somebody's cash sale as paid by money that never
    // arrived.
    expect(call.text).toContain("and sp.method = 'momo'");
  });

  it('takes the earliest match, and only one', async () => {
    const { sql, calls } = recorder();

    await findSalePaymentByReference(sql, 'S-000042-0');

    const text = onlyCall(calls).text;
    expect(text).toContain('order by sp.created_at, sp.id');
    expect(text).toContain('limit 1');
    // Two tenders sharing one gateway reference would mean two charges bound to
    // one id. The reference's construction prevents it and nothing in this build
    // can produce it, so this is a tie-break for a state believed unreachable —
    // which still deserves a deterministic answer, because the alternative is
    // whichever row Postgres happened to return first.
  });
});

// ---------------------------------------------------------------------------
// Moving a tender to a terminal state
// ---------------------------------------------------------------------------

describe('updateSalePaymentStatus', () => {
  /** Shared by all four shapes, and the reason a `toContain` is not enough. */
  const RETURNING =
    'returning id, sale_id, method, status, amount, reference, gateway_response, ' +
    'paid_at, created_at, updated_at';

  it('emits one of four shapes, and renumbers the guard after the sets', async () => {
    const { sql, calls } = recorder();

    await updateSalePaymentStatus(sql, PAYMENT, { status: 'succeeded', allowedFrom: ['pending'] });
    await updateSalePaymentStatus(sql, PAYMENT, {
      status: 'succeeded',
      gatewayResponse: { status: 'success' },
      allowedFrom: ['pending'],
    });
    await updateSalePaymentStatus(sql, PAYMENT, {
      status: 'failed',
      paidAt: null,
      allowedFrom: ['pending'],
    });
    await updateSalePaymentStatus(sql, PAYMENT, {
      status: 'succeeded',
      gatewayResponse: { status: 'success' },
      paidAt: STAMP_ISO,
      allowedFrom: ['pending'],
    });

    // Whole statements rather than fragments, because the property under test is
    // the *numbering*: the guard placeholder is pushed last, after the set list
    // has been assembled, so its position moves with whichever optionals the
    // caller supplied. A doc naming `$4` here would be a lie the first time an
    // optional was left out, and a fragment assertion would not catch it.
    expect(calls.map((call) => call.text)).toEqual([
      `update sale_payments set status = $2::sale_payment_status where id = $1 ` +
        `and status = any($3::sale_payment_status[]) ${RETURNING}`,
      `update sale_payments set status = $2::sale_payment_status, ` +
        `gateway_response = $3::jsonb where id = $1 ` +
        `and status = any($4::sale_payment_status[]) ${RETURNING}`,
      `update sale_payments set status = $2::sale_payment_status, paid_at = $3 ` +
        `where id = $1 and status = any($4::sale_payment_status[]) ${RETURNING}`,
      `update sale_payments set status = $2::sale_payment_status, ` +
        `gateway_response = $3::jsonb, paid_at = $4 where id = $1 ` +
        `and status = any($5::sale_payment_status[]) ${RETURNING}`,
    ]);

    // And the values line up with those numbers, which is the half a text
    // assertion cannot see: the gateway payload is serialised, not bound as an
    // object, because a nested object bound directly is sent as `[object
    // Object]` by some drivers and as JSON by others.
    expect(calls[3]?.params).toEqual([
      PAYMENT,
      'succeeded',
      '{"status":"success"}',
      STAMP_ISO,
      ['pending'],
    ]);
  });

  it('casts both sides of the guard, which is the load-bearing shape in this file', async () => {
    const { sql, calls } = recorder();

    await updateSalePaymentStatus(sql, PAYMENT, { status: 'succeeded', allowedFrom: ['pending'] });

    const call = onlyCall(calls);
    expect(call.params).toEqual([PAYMENT, 'succeeded', ['pending']]);
    expect(call.text).toContain('status = $2::sale_payment_status');
    // A parameter on one side of a comparison against an enum column, with no
    // literal anywhere in the statement to give it a type. This is landmine 1
    // exactly, and it is the shape that stopped every sale on the previous build:
    // uncast, the parser resolves `$2` to text, the statement is rejected at parse
    // time, and every webhook and every `verify` in the pharmacy answers a bare
    // 500 that reads like a gateway outage. The list beside it is cast once as an
    // array rather than per element, because `any($3)` hands the parser one
    // unknown and not a list of them.
    expect(call.text).toContain('status = any($3::sale_payment_status[])');
  });

  it('cannot rewrite the reference, whatever the gateway said', async () => {
    const { sql, calls } = recorder();

    await updateSalePaymentStatus(sql, PAYMENT, {
      status: 'succeeded',
      gatewayResponse: { reference: 'chosen-by-the-gateway' },
      allowedFrom: ['pending'],
    });

    const call = onlyCall(calls);
    // Scoped to the SET list, because `reference` appears legitimately in the
    // RETURNING list a few words later and a whole-statement check would either
    // fail on that or be weakened until it proved nothing.
    const setList = call.text.split(' where ')[0] ?? '';
    expect(setList).not.toContain('reference');
    // `sale_payments.reference` on a mobile money tender is the only thing a
    // webhook has to find that tender with. A statement that can rewrite it can
    // orphan every later webhook for the same charge, and the rewrite would come
    // from a value read out of a third party's payload. What the gateway said
    // belongs in `gateway_response`, which is a jsonb column that exists to hold
    // exactly that, verbatim.
    expect(setList).toContain('gateway_response = $3::jsonb');
    expect(call.params[2]).toBe('{"reference":"chosen-by-the-gateway"}');
  });

  it('guards in the statement, so a webhook and a verify cannot both be first', async () => {
    const { sql, calls } = recorder();

    await updateSalePaymentStatus(sql, PAYMENT, {
      status: 'succeeded',
      allowedFrom: ['pending', 'failed'],
    });

    const call = onlyCall(calls);
    // Two statuses, so the assertion is on a list and not on a one-element array
    // that would look the same bound as a scalar. A charge retried after a
    // failure arrives here from `pending` or from `failed` and from nothing else.
    expect(call.params[2]).toEqual(['pending', 'failed']);
    // In the WHERE, not in a read before it. A Paystack webhook and a `verify`
    // call can arrive for the same tender within a second of each other and both
    // are entitled to think they are first. Read-then-write lets the second
    // overwrite the first, and a payment that succeeded can be re-marked
    // `pending` by a delayed webhook — which undoes a settlement the drawer has
    // already felt. Guarded, the second finds no row and reports that nothing
    // changed, which is the truth.
    expect(afterWhere(call.text)).toContain('and status = any($3::sale_payment_status[])');
  });
});

// ---------------------------------------------------------------------------
// What no statement in this file may do
// ---------------------------------------------------------------------------

describe('what no statement in this file may do', () => {
  it('writes no stock, because stock is not this file\u2019s to write', async () => {
    const calls = await everyStatementShape();

    // The seven-step write path does decrement a batch and does write a ledger
    // row, and neither statement is here: `sales.service.ts` calls
    // `setBatchQuantity` and `insertMovement` from the inventory repository on
    // the same transaction client, and both are pinned in
    // `inventory.repository.test.ts`. That is not tidiness. `inventory`'s stock
    // columns are derived — `recompute_inventory_from_batches` overwrites them
    // from `inventory_batches` on the next write — so a sale that adjusted one
    // directly would be silently undone, and the drawer and the shelf would
    // disagree with no error raised anywhere.
    const stockWrites = calls.filter((call) =>
      /\b(?:update|insert into|delete from)\s+inventory\b/u.test(call.text)
    );
    expect(stockWrites.map((call) => call.text)).toEqual([]);

    // The one stock table this file names at all, and it names it to read a lot
    // number for a recall, never to move a unit.
    const naming = calls.filter((call) => call.text.includes('inventory_batches'));
    expect(naming).toHaveLength(1);
    expect(naming[0]?.text).toContain('join inventory_batches b on b.id = sib.batch_id');
  });

  it('holds four quoted literals, and a fifth would be a value spliced in', async () => {
    const calls = await everyStatementShape();

    // An allowlist, where `inventory.repository.test.ts` uses a prohibition, and
    // the difference is honest rather than convenient: this file has four
    // legitimate literals — two enum values each carrying its own cast, one
    // interval, and the empty-array literal `coalesce` needs — and that one has
    // none. All four are constants of the statement. A caller's value reaching
    // the text would add a fifth, so the assertion is on the exact set; a
    // `toContain` would pass on any number of additions.
    const quoted = new Set(
      calls.flatMap((call) =>
        [...call.text.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '')
      )
    );
    expect([...quoted].sort()).toEqual(['1 day', 'momo', 'voided', '{}']);
  });

  it('casts every enum parameter it compares, in every statement it can emit', async () => {
    const calls = await everyStatementShape();

    // Guarding the guard first: a scan that finds nothing is indistinguishable
    // from a scan whose targets have been deleted, so the three casts this file
    // exists for are asserted present before the absence of uncast ones is.
    const joined = calls.map((call) => call.text).join('\n');
    expect(joined).toContain('s.status = $2::sale_status');
    expect(joined).toContain('set status = $2::sale_payment_status');
    expect(joined).toContain('status = any($3::sale_payment_status[])');

    // Read from after the first `where`, because that is where comparisons live.
    // `set status = $4` is a column being written and the column supplies its
    // type; `where status = $2` is a comparison the parser has to resolve between
    // two unknowns, and it picks text. Scanning both together fires on every
    // correct assignment in the file, and a scan with twenty false positives is a
    // scan somebody narrows until it misses the real one.
    const uncast = calls.flatMap((call) =>
      [
        ...afterWhere(call.text).matchAll(
          /(?:\w+\.)?(status|method)\s*(?:=|<>|!=)\s*(\$\d+)(::[a-z_]+)?/g
        ),
      ]
        .filter((match) => match[3] === undefined)
        .map((match) => `${match[0]} in: ${call.text}`)
    );
    expect(uncast).toEqual([]);

    // The array guard separately, because `any($3)` is not `status = $3` and the
    // regex above cannot see it: `= any(` puts a function call between the
    // operator and the parameter. It is the most load-bearing cast in the file
    // and it would be the one a single generic scan quietly skipped.
    const uncastArray = calls.flatMap((call) =>
      [...afterWhere(call.text).matchAll(/any\((\$\d+)(::[a-z_]+\[\])?/g)]
        .filter((match) => match[2] === undefined)
        .map((match) => `${match[0]} in: ${call.text}`)
    );
    expect(uncastArray).toEqual([]);
  });

  it('binds every value, so nothing a caller supplies can reach the text', async () => {
    const hostileText = "S-1' or '1'='1";
    const hostileUuid = "a0000000-0000-4000-8000-000000000001' union select null --";

    const calls = await (async () => {
      const { sql, calls: recorded } = recorder();

      await nextSaleNumber(sql, hostileUuid);
      await insertSale(sql, {
        ...NEW_SALE,
        pharmacyId: hostileUuid,
        saleNumber: hostileText,
        servedBy: hostileText,
        discountReason: hostileText,
        clientSaleId: hostileText,
      });
      await insertSaleItem(sql, {
        ...NEW_ITEM,
        saleId: hostileUuid,
        inventoryId: hostileUuid,
        description: hostileText,
      });
      await insertSaleItemBatch(sql, {
        saleItemId: hostileUuid,
        batchId: hostileUuid,
        quantity: 1,
        unitCost: hostileText,
      });
      await insertSalePayment(sql, {
        ...NEW_PAYMENT,
        saleId: hostileUuid,
        reference: hostileText,
        gatewayResponse: { note: hostileText },
      });
      await findSaleById(sql, hostileUuid, hostileUuid);
      await findSaleByClientSaleId(sql, hostileUuid, hostileText);
      await patientExists(sql, hostileUuid, hostileUuid);
      await lockSale(sql, hostileUuid, hostileUuid);
      await listSaleItems(sql, hostileUuid);
      await listSaleItemBatches(sql, hostileUuid);
      await listSalePayments(sql, hostileUuid);
      await listSales(sql, hostileUuid, {
        status: 'pending',
        servedBy: hostileText,
        from: hostileText,
        to: hostileText,
        search: hostileText,
        limit: 50,
        offset: 0,
      });
      await updateSaleSettlement(sql, hostileUuid, {
        amountPaid: hostileText,
        changeGiven: hostileText,
        status: 'completed',
      });
      await markSaleVoided(sql, hostileUuid, { reason: hostileText, voidedAt: hostileText });
      await findSalePayment(sql, hostileUuid, hostileUuid);
      await findSalePaymentByReference(sql, hostileText);
      await updateSalePaymentStatus(sql, hostileUuid, {
        status: 'succeeded',
        gatewayResponse: hostileText,
        paidAt: hostileText,
        allowedFrom: ['pending'],
      });

      return recorded;
    })();

    // Nineteen calls for eighteen exported functions, `nextSaleNumber` being two.
    // Exact rather than a minimum, so that a function added to this repository
    // without being added to this drive fails here instead of going unproven.
    expect(calls).toHaveLength(19);

    const leaked = calls.filter(
      (call) => call.text.includes('union select') || call.text.includes(hostileText)
    );
    expect(leaked.map((call) => call.text)).toEqual([]);

    // And positively: the values did travel, as parameters. A drive in which
    // every hostile value was dropped before it reached the statement would pass
    // the assertion above by proving nothing.
    const allParams = calls.flatMap((call) => call.params);
    expect(allParams).toContain(hostileUuid);
    expect(allParams).toContain(hostileText);
  });
});

// ---------------------------------------------------------------------------
// The tie to the Postgres harness
// ---------------------------------------------------------------------------

describe('the Postgres harness carries these same statements', () => {
  // Pinning SQL as text proves the repository builds what we intend and nothing
  // more: it cannot tell us Postgres accepts it. That is what section 13 of
  // `database/tests/assertions.sql` is for, which PREPAREs each of these against
  // a real Postgres 16 and then runs the seven-step write path for real, so the
  // stock movement is the trigger's and not this suite's idea of it.
  //
  // But section 13 holds a copy. Left alone it drifts: somebody edits the
  // repository, the harness keeps preparing the old statement, and it goes on
  // reporting PASS while proving nothing about the code that ships. This is the
  // tie between the two halves, in both directions.
  const harnessPath = path.resolve(
    __dirname, '..', '..', '..', 'database', 'tests', 'assertions.sql'
  );

  /** The normalised body of every `prepare sales_repo_* as ...;` in the harness. */
  function harnessStatements(): Set<string> {
    const source = fs.readFileSync(harnessPath, 'utf8');
    // Scoped to this repository's prefix. Section 9 prepares the users
    // repository's statements, section 10 the inventory repository's and section
    // 6 two sales statements written by hand as a PREPARE-as-oracle experiment;
    // counting any of those as ours would let a stale one hide among them.
    const bodies = [...source.matchAll(/prepare\s+sales_repo_\w+\s+as\s+([\s\S]*?);/g)].map(
      (match) => match[1]
    );
    if (bodies.length === 0) {
      throw new Error(
        `no \`prepare sales_repo_* as\` statements found in ${harnessPath}; section 13 of ` +
          'the harness is how these statements are proven to parse against real Postgres ' +
          'and how the seven-step write path is proven to move stock through the trigger, ' +
          'so restore it rather than deleting this test'
      );
    }
    return new Set(bodies.map((body) => normalise(body ?? '')));
  }

  it('proves each of them against the harness, and fails naming any it has lost', async () => {
    const statements = (await everyStatementShape()).map((call) => call.text);
    const harness = harnessStatements();

    // Guarding the guard: if the drive stopped issuing statements the comparison
    // below would pass against nothing. The same drive backs the enum-cast scan
    // and the literal allowlist, so all three now fail together rather than one
    // drifting past the other — which is what happened when the inventory suite
    // had two copies of its own drive.
    expect(statements.length).toBeGreaterThanOrEqual(24);

    const missing = [...new Set(statements)].filter((statement) => !harness.has(statement));
    expect(missing).toEqual([]);
  });

  it('has no prepared statement in the harness that the repository no longer emits', async () => {
    const statements = new Set((await everyStatementShape()).map((call) => call.text));
    const harness = harnessStatements();

    // The other direction. A prepared statement left behind after the repository
    // changed would keep the harness green for a shape nothing produces, and the
    // real shape would go unproven — which is the same failure as no harness at
    // all, except that it reports PASS.
    const stale = [...harness].filter((statement) => !statements.has(statement));
    expect(stale).toEqual([]);
  });
});
