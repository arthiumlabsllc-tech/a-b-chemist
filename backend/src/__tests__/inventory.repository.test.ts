import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Sql } from '../database/pool';
import {
  createProduct,
  findBatch,
  findBatchByLot,
  findProductByCode,
  findProductById,
  insertBatch,
  insertMovement,
  likePattern,
  listActiveProducts,
  listBatchesForProduct,
  listBatchesHoldingStock,
  listMovements,
  listProducts,
  lockProduct,
  mergeIntoBatch,
  recallTrace,
  setBatchQuantity,
  updateProduct,
  type NewProduct,
  type ProductPatch,
} from '../repositories/inventory.repository';
import { HttpError } from '../utils/http';

/**
 * The SQL the inventory repository emits.
 *
 * Every other suite that touches stock mocks this module, so this is the only
 * place the statements themselves are pinned. The interesting failures are not
 * logic errors a reader would spot: they are a placeholder numbered one out, a
 * derived column that creeps into a SET list, a `$3::numeric` cast dropped while
 * somebody was tidying, or a value interpolated into the statement instead of
 * passed as a parameter. All four compile. All four pass a service test that
 * mocks the repository. The first two only appear when a real batch is merged.
 *
 * Unlike `users.repository.test.ts` there is no `jest.mock` of the pool here, and
 * that is a property of the repository worth keeping: every function takes a
 * `Sql` rather than importing one, because stock writes are multi-statement and
 * must run on a transaction client. The consequence is that a recording stub is
 * the whole test harness, with no module boundary to fake.
 *
 * This proves construction, not execution. That the statements are also valid
 * against the real schema is section 10 of `database/tests/assertions.sql`,
 * which PREPAREs each of them in Postgres 16 and then runs the four behaviours
 * they exist for. The last describe block here is the tie between the two.
 */

interface Call {
  text: string;
  params: unknown[];
}

/** Collapses whitespace, so a reformat is not a failure but a rewrite is. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const STAMP = new Date('2026-03-15T09:00:00.000Z');

/** One row wide enough for every mapper in the repository. */
function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a0000000-0000-4000-8000-000000000010',
    pharmacy_id: 'a0000000-0000-4000-8000-000000000001',
    inventory_id: 'a0000000-0000-4000-8000-000000000010',
    sale_id: null,
    batch_id: 'a0000000-0000-4000-8000-000000000012',
    sale_number: 'S-0001',
    status: 'completed',
    served_by: 'Ama Mensah',
    performed_by: 'a0000000-0000-4000-8000-000000000002',
    performed_by_name: 'Ama Mensah',
    patient_name: 'Kofi Asare',
    patient_phone: '0244000000',
    name: 'Paracetamol 500mg',
    code: 'PARA-500',
    generic_name: 'Paracetamol',
    category: 'Analgesic',
    manufacturer: 'Lab',
    description: 'Paracetamol 500mg x 10',
    pack_size: 10,
    default_sell_unit: 'single',
    sell_unit: 'single',
    shelf_location: 'A1',
    barcode: '1234567890',
    lot_number: 'LOT-1',
    requires_prescription: false,
    reorder_level: 20,
    unit_price: '12.50',
    unit_cost: '8.2500',
    cost_price: '8.2500',
    vat_treatment: 'exempt',
    is_active: true,
    quantity: 100,
    units: 4,
    batch_number: 'LOT-1',
    movement_type: 'receive',
    quantity_change: 100,
    quantity_after: 100,
    reason: 'Delivery',
    note: 'Invoice 4411',
    expiry_date: '2027-01-31',
    received_at: STAMP,
    sold_at: STAMP,
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

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const PRODUCT = 'a0000000-0000-4000-8000-000000000010';
const BATCH = 'a0000000-0000-4000-8000-000000000012';
const OWNER = 'a0000000-0000-4000-8000-000000000002';
const SALE = 'a0000000-0000-4000-8000-000000000020';

const NEW_PRODUCT: NewProduct = {
  pharmacyId: PHARMACY,
  name: 'Paracetamol 500mg',
  code: 'PARA-500',
  genericName: 'Paracetamol',
  category: 'Analgesic',
  manufacturer: 'Lab',
  packSize: 10,
  defaultSellUnit: 'single',
  shelfLocation: 'A1',
  barcode: '1234567890',
  requiresPrescription: false,
  reorderLevel: 20,
  unitPrice: '12.50',
  vatTreatment: 'exempt',
  isActive: true,
};

/** Every editable column, which is the patch shape whose numbering is easiest to get wrong. */
const FULL_PATCH: ProductPatch = {
  name: 'Paracetamol 500mg',
  genericName: 'Paracetamol',
  category: 'Analgesic',
  manufacturer: 'Lab',
  packSize: 10,
  defaultSellUnit: 'pack',
  shelfLocation: 'A1',
  barcode: '1234567890',
  requiresPrescription: true,
  reorderLevel: 20,
  unitPrice: '13.00',
  vatTreatment: 'standard',
  isActive: false,
};

/** The single statement a call is expected to have produced. */
function onlyCall(calls: Call[]): Call {
  if (calls.length !== 1) {
    throw new Error(`expected exactly one query, saw ${calls.length}: ${JSON.stringify(calls)}`);
  }
  const first = calls[0];
  if (first === undefined) throw new Error('unreachable: the length was checked above');
  return first;
}

/** Placeholder numbers used by a statement, in the order they appear. */
function placeholders(text: string): number[] {
  return [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
}

/**
 * Every statement shape the repository can emit, driven once each.
 *
 * One list, shared by two different checks: the derived-column scan and the tie
 * to the Postgres harness. It started as two lists, and they drifted — one was
 * missing two of the three `listProducts` filter shapes, so a guard written
 * against the other list's count failed for a reason that had nothing to do with
 * the repository. Two lists that have to agree are one list.
 *
 * The shapes are the ones whose text changes: three `listProducts` filter
 * combinations, each of which renumbers the placeholders; three `updateProduct`
 * patches — one column, all thirteen, and the empty patch that issues no UPDATE
 * at all; and one of everything else.
 *
 * Twenty-one calls, twenty distinct statements: the empty patch re-reads with
 * the same text `findProductById` emits.
 */
async function everyStatementShape(): Promise<Call[]> {
  const { sql, calls } = recorder();

  await listProducts(sql, PHARMACY, { limit: 50, offset: 0 });
  await listProducts(sql, PHARMACY, { includeInactive: true, search: 'p', category: 'c', limit: 20, offset: 40 });
  await listProducts(sql, PHARMACY, { search: 'p', limit: 50, offset: 0 });
  await findProductById(sql, PHARMACY, PRODUCT);
  await findProductByCode(sql, PHARMACY, 'PARA-500');
  await lockProduct(sql, PHARMACY, PRODUCT);
  await createProduct(sql, NEW_PRODUCT);
  await updateProduct(sql, PHARMACY, PRODUCT, { name: 'Renamed' });
  await updateProduct(sql, PHARMACY, PRODUCT, FULL_PATCH);
  await updateProduct(sql, PHARMACY, PRODUCT, {});
  await listBatchesForProduct(sql, PHARMACY, PRODUCT);
  await listBatchesHoldingStock(sql, PHARMACY);
  await listActiveProducts(sql, PHARMACY);
  await findBatch(sql, PHARMACY, BATCH);
  await findBatchByLot(sql, PHARMACY, PRODUCT, 'LOT-1');
  await insertBatch(sql, {
    pharmacyId: PHARMACY,
    inventoryId: PRODUCT,
    lotNumber: 'LOT-1',
    expiryDate: '2027-01-31',
    quantity: 100,
    costPrice: '8.2500',
    receivedAt: '2026-03-15T09:00:00.000Z',
  });
  await mergeIntoBatch(sql, BATCH, 5, '9.0000');
  await setBatchQuantity(sql, BATCH, 40);
  await insertMovement(sql, {
    pharmacyId: PHARMACY,
    inventoryId: PRODUCT,
    batchId: BATCH,
    movementType: 'receive',
    quantityChange: 100,
    quantityAfter: 100,
    reason: 'Delivery',
    note: 'Invoice 4411',
    performedBy: OWNER,
  });
  await listMovements(sql, PHARMACY, PRODUCT, 50);
  await recallTrace(sql, PHARMACY, BATCH);

  return calls;
}

describe('reads', () => {
  it('maps every column, and turns timestamps into ISO strings', async () => {
    const { sql } = recorder();

    const product = await findProductById(sql, PHARMACY, PRODUCT);

    // `created_at` and `updated_at` arrive from the driver as Date objects and
    // leave as ISO-8601, because the API speaks strings and a Date serialised by
    // Express would be a format the frontend has to parse differently per field.
    expect(product).toEqual({
      id: PRODUCT,
      pharmacyId: PHARMACY,
      name: 'Paracetamol 500mg',
      code: 'PARA-500',
      genericName: 'Paracetamol',
      category: 'Analgesic',
      manufacturer: 'Lab',
      packSize: 10,
      defaultSellUnit: 'single',
      shelfLocation: 'A1',
      barcode: '1234567890',
      requiresPrescription: false,
      reorderLevel: 20,
      unitPrice: '12.50',
      vatTreatment: 'exempt',
      isActive: true,
      quantity: 100,
      batchNumber: 'LOT-1',
      expiryDate: '2027-01-31',
      costPrice: '8.2500',
      createdAt: '2026-03-15T09:00:00.000Z',
      updatedAt: '2026-03-15T09:00:00.000Z',
    });
  });

  it('leaves a numeric column as the string the driver returned', async () => {
    const { sql } = recorder();

    const product = await findProductById(sql, PHARMACY, PRODUCT);

    // Never a double. `numeric` arrives as a string and stays one, because a
    // till that adds money in doubles is off by a pesewa on some totals.
    expect(typeof product?.unitPrice).toBe('string');
    expect(typeof product?.costPrice).toBe('string');
  });

  it('returns null, not undefined, when a read finds nothing', async () => {
    const { sql, alwaysEmpty } = recorder();
    alwaysEmpty();

    await expect(findProductById(sql, PHARMACY, PRODUCT)).resolves.toBeNull();
    await expect(findProductByCode(sql, PHARMACY, 'NOPE')).resolves.toBeNull();
    await expect(lockProduct(sql, PHARMACY, PRODUCT)).resolves.toBeNull();
    await expect(findBatch(sql, PHARMACY, BATCH)).resolves.toBeNull();
    await expect(findBatchByLot(sql, PHARMACY, PRODUCT, 'LOT-X')).resolves.toBeNull();
  });

  it('reads batches in the FEFO order, which is the allocator order written in SQL', async () => {
    const { sql, calls } = recorder();

    await listBatchesForProduct(sql, PHARMACY, PRODUCT);

    const text = onlyCall(calls).text;
    // `expiry_date nulls last, received_at, id` is utils/fefo.ts's compareFefo.
    // This order decides which lot the batch panel shows first and the allocator
    // decides which lot the till draws from; they disagree and the screen shows
    // one lot while the sale takes another. Section 10b of the harness asserts
    // the resulting sequence on seven real rows.
    expect(text).toContain('order by expiry_date nulls last, received_at, id');
    expect(onlyCall(calls).params).toEqual([PHARMACY, PRODUCT]);
  });

  it('scopes the alert-scan reads to the pharmacy and to stock that is there', async () => {
    const { sql, calls } = recorder();

    await listBatchesHoldingStock(sql, PHARMACY);
    await listActiveProducts(sql, PHARMACY);

    expect(calls[0]?.text).toContain('where pharmacy_id = $1 and quantity > 0');
    expect(calls[1]?.text).toContain('where pharmacy_id = $1 and is_active = true');
    // The scan reads every batch holding stock in one statement and groups by
    // product in TypeScript, so the expiry rule stays in utils/fefo.ts rather
    // than being restated as a SQL date range that could drift from it.
    expect(calls[0]?.text).toContain('order by inventory_id,');
  });

  it('locks the product row, not the batch, for the write path', async () => {
    const { sql, calls } = recorder();

    await lockProduct(sql, PHARMACY, PRODUCT);

    expect(onlyCall(calls).text).toMatch(/for update$/u);
    // Locking the product covers every batch of it in one lock. Receive, adjust
    // and write-off all read a batch and then write it; without the lock two of
    // them interleave and the last writer's `quantity_after` is a figure no batch
    // ever held.
    expect(onlyCall(calls).text).toContain('from inventory where pharmacy_id = $1 and id = $2');
  });
});

describe('likePattern', () => {
  it('escapes the wildcards so a search is literal', () => {
    // `%` and `_` are wildcards and `\` is the escape character. A term left
    // unescaped changes what the search means rather than what it matches:
    // looking for "50%" would return every product in the pharmacy.
    expect(likePattern('50%')).toBe('%50\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('back\\slash')).toBe('%back\\\\slash%');
    expect(likePattern('plain')).toBe('%plain%');
  });

  it('passes the escaped term as a parameter, never into the statement', async () => {
    const { sql, calls } = recorder();

    await listProducts(sql, PHARMACY, { search: "'; drop table inventory; --", limit: 1, offset: 0 });

    const text = onlyCall(calls).text;
    expect(text).not.toContain('drop table');
    // The escaped term travels as a parameter, and `likePattern` escapes only the
    // three characters that mean something to LIKE: `\`, `%` and `_`. The quote is
    // deliberately left alone — the value is bound, so it never goes through SQL
    // lexing, and doubling the quote here would mean searching for a term the
    // caller did not type.
    expect(onlyCall(calls).params[1]).toBe("%'; drop table inventory; --%");
  });
});

describe('listProducts', () => {
  it('excludes inactive products unless asked for them', async () => {
    const { sql, calls } = recorder();

    await listProducts(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(onlyCall(calls).text).toContain('where pharmacy_id = $1 and is_active = true');
    expect(onlyCall(calls).params).toEqual([PHARMACY, 50, 0]);
  });

  it('drops the active filter, and only that, when includeInactive is true', async () => {
    const { sql, calls } = recorder();

    await listProducts(sql, PHARMACY, { includeInactive: true, limit: 50, offset: 0 });

    const text = onlyCall(calls).text;
    // Scoped to the WHERE clause. `is_active` is in the SELECT list and must be:
    // the whole point of asking for inactive products is that the caller can see
    // which ones they are. What has to go is the predicate.
    const whereClause = text.split(' where ')[1] ?? '';
    expect(whereClause).not.toContain('is_active');
    // Removing a predicate must not remove a parameter: the numbering below has
    // to stay contiguous or Postgres rejects the statement at runtime.
    expect(onlyCall(calls).params).toEqual([PHARMACY, 50, 0]);
  });

  it('numbers placeholders contiguously across every filter combination', async () => {
    // The failure this suite exists for. The WHERE list and the LIMIT/OFFSET are
    // built together, so the position of each parameter depends on which filters
    // were supplied — and a value pushed without a placeholder, or the reverse,
    // produces SQL Postgres rejects with no compile error and no failure anywhere
    // else.
    const { sql, calls } = recorder();

    const combinations = [
      { limit: 50, offset: 0 },
      { includeInactive: true, limit: 50, offset: 0 },
      { category: 'Analgesic', limit: 50, offset: 0 },
      { search: 'para', limit: 50, offset: 0 },
      { search: 'para', category: 'Analgesic', limit: 50, offset: 0 },
      { includeInactive: true, search: 'para', category: 'Analgesic', limit: 20, offset: 40 },
    ];

    const checked: { index: number; distinct: number[]; expected: number[]; text: string }[] = [];

    // Sequential, and that is load-bearing rather than a style choice. Resetting
    // `calls` inside a `.map` and collecting the promises looks equivalent and is
    // not: `listProducts` pushes its call synchronously before it suspends at the
    // `await`, so iteration N+1 wipes iteration N's recording before N's `.then`
    // ever runs. Every callback then reads the one surviving entry and the test
    // checks the widest combination six times while reporting six passes. It did
    // exactly that, and the guard below is why it cannot again.
    for (const [index, filters] of combinations.entries()) {
      calls.length = 0;
      await listProducts(sql, PHARMACY, filters);

      const call = onlyCall(calls);
      const used = placeholders(call.text);
      checked.push({
        index,
        distinct: [...new Set(used)].sort((left, right) => left - right),
        expected: call.params.map((_value, position) => position + 1),
        text: call.text,
      });
    }

    // Six combinations must produce six different statements. If they collapse —
    // a filter silently ignored, or the degeneration above returning — contiguity
    // can hold on every one of them while the shapes are no longer being varied.
    expect(new Set(checked.map((result) => result.text)).size).toBe(combinations.length);

    for (const result of checked) {
      // Carrying `index` in both sides means a failure names the combination that
      // broke instead of pointing at a line inside a loop.
      expect({ index: result.index, distinct: result.distinct }).toEqual({
        index: result.index,
        distinct: result.expected,
      });
    }
  });

  it('reuses one parameter for all four search predicates', async () => {
    const { sql, calls } = recorder();

    await listProducts(sql, PHARMACY, { search: 'para', limit: 50, offset: 0 });

    // One parameter, four `ilike`s, all against text columns, so the parser
    // deduces text once and consistently. Binding the term four times would work
    // and would also mean four chances for the escaping to be applied unevenly.
    const text = onlyCall(calls).text;
    expect(text).toContain('(name ilike $2 or code ilike $2 or generic_name ilike $2 or barcode ilike $2)');
    expect(onlyCall(calls).params).toHaveLength(4);
  });
});

describe('updateProduct', () => {
  it('numbers the id last, after every value the SET clause consumed', async () => {
    const { sql, calls } = recorder();

    await updateProduct(sql, PHARMACY, PRODUCT, FULL_PATCH);

    const call = onlyCall(calls);
    // Thirteen editable columns, then pharmacy_id at $14 and id at $15.
    expect(call.text).toContain('where pharmacy_id = $14 and id = $15');
    expect(call.params).toHaveLength(15);
    expect(call.params[13]).toBe(PHARMACY);
    expect(call.params[14]).toBe(PRODUCT);
  });

  it('numbers contiguously for a one-column patch too', async () => {
    const { sql, calls } = recorder();

    await updateProduct(sql, PHARMACY, PRODUCT, { name: 'Renamed' });

    const call = onlyCall(calls);
    expect(call.text).toContain('update inventory set name = $1 where pharmacy_id = $2 and id = $3');
    expect(call.params).toEqual(['Renamed', PHARMACY, PRODUCT]);
  });

  it('omits updated_at, because the trigger stamps it with the database clock', async () => {
    const { sql, calls } = recorder();

    await updateProduct(sql, PHARMACY, PRODUCT, FULL_PATCH);

    const setClause = onlyCall(calls).text.split(' where ')[0] ?? '';
    // A value supplied from the app server would be overwritten by set_updated_at
    // anyway, and the database clock is the one worth having because it does not
    // depend on whichever container happened to serve the request.
    expect(setClause).not.toContain('updated_at');
  });

  it('issues no update at all for an empty patch, and re-reads instead', async () => {
    const { sql, calls } = recorder();

    await updateProduct(sql, PHARMACY, PRODUCT, {});

    expect(calls.map((call) => call.text)).toEqual([
      expect.stringContaining('from inventory where pharmacy_id = $1 and id = $2'),
    ]);
    // Not `not.toContain('update')`: the re-read selects `updated_at`, so that
    // assertion fails on a column name. What matters is that the one statement
    // issued is a read.
    expect(calls[0]?.text.startsWith('select')).toBe(true);
  });

  it('returns null when the update matched no row', async () => {
    const { sql, alwaysEmpty } = recorder();
    alwaysEmpty();

    // A PATCH against another pharmacy's product matches nothing. Answering null
    // lets the service return 404 rather than a 200 with an empty body.
    await expect(updateProduct(sql, PHARMACY, PRODUCT, { name: 'X' })).resolves.toBeNull();
  });
});

describe('the four derived product columns are never written', () => {
  // The acceptance criterion, at the level where it is a structural fact rather
  // than a route behaviour. `quantity`, `batch_number`, `expiry_date` and
  // `cost_price` on `inventory` are recomputed by
  // recompute_inventory_from_batches from the batches, so a value written to them
  // is at best discarded and at worst a lie that survives until the next batch
  // changes. ASSERT 3 of the harness proves the database discards such a write;
  // this proves the repository never attempts one.
  const DERIVED = ['quantity', 'batch_number', 'expiry_date', 'cost_price'];

  it('drives enough of the repository that the check below is not vacuous', async () => {
    const calls = await everyStatementShape();
    // Guarding the guard. If the drive above stopped issuing statements — a
    // signature change, an early return, a driver that lost two shapes — the
    // scan below would pass against nothing and the acceptance criterion would
    // be unproven while still reporting green.
    expect(calls.length).toBeGreaterThanOrEqual(20);
    // And it must reach the statements that write to the product table, or the
    // scan is looking at reads that could never have named a derived column.
    expect(calls.some((call) => call.text.startsWith('insert into inventory ('))).toBe(true);
    expect(calls.some((call) => call.text.startsWith('update inventory set'))).toBe(true);
  });

  it('names none of them in a product INSERT column list or a product SET clause', async () => {
    const calls = await everyStatementShape();
    const violations: string[] = [];

    for (const call of calls) {
      // Only the product table. `inventory_batches` legitimately holds a real
      // `quantity` and a real `cost_price` — it is the source of truth the
      // derived columns are computed from.
      const isProductInsert = call.text.startsWith('insert into inventory (');
      const isProductUpdate = call.text.startsWith('update inventory set');
      if (!isProductInsert && !isProductUpdate) continue;

      // The written part only: RETURNING lists all four on every one of these
      // statements, so scanning the whole text would fail for a reason that has
      // nothing to do with whether anything was written.
      const written = isProductInsert
        ? (call.text.split(' values ')[0] ?? '')
        : (call.text.split(' where ')[0] ?? '');

      for (const column of DERIVED) {
        const pattern = new RegExp(`(^|[\\s(,])${column}([\\s,)=]|$)`, 'u');
        if (pattern.test(written)) {
          violations.push(`${column} is written by: ${written}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('does read them back, so the response carries the recomputed figures', async () => {
    const calls = await everyStatementShape();

    // The other half. Discarding a supplied value is only useful if the answer
    // still says what the columns now hold, and they are read by RETURNING on
    // every product write.
    const returning = calls.filter((call) => call.text.includes('returning'));
    expect(returning.length).toBeGreaterThan(0);
    for (const call of returning) {
      const tail = call.text.split(' returning ')[1] ?? '';
      if (!call.text.startsWith('insert into inventory (') && !call.text.startsWith('update inventory set')) {
        continue;
      }
      for (const column of DERIVED) {
        expect({ column, present: tail.includes(column) }).toEqual({ column, present: true });
      }
    }
  });
});

describe('the batch writes', () => {
  it('prices a merge at the quantity-weighted average, with the money cast load-bearing', async () => {
    const { sql, calls } = recorder();

    await mergeIntoBatch(sql, BATCH, 5, '9.0000');

    const call = onlyCall(calls);
    expect(call.text).toBe(
      'update inventory_batches set quantity = quantity + $2, ' +
        'cost_price = round(((quantity * cost_price) + ($2 * $3::numeric)) / (quantity + $2), 4) ' +
        'where id = $1 returning id, pharmacy_id, inventory_id, lot_number, expiry_date, ' +
        'quantity, cost_price, received_at, created_at, updated_at'
    );
    expect(call.params).toEqual([BATCH, 5, '9.0000']);

    // Without `::numeric` an `integer * unknown` resolution can deduce integer and
    // silently truncate every cost price to whole cedis. Both SET expressions read
    // the pre-update row, which is Postgres's rule rather than an ordering
    // accident, and ASSERT 10c of the harness checks the figure it produces.
    expect(call.text).toContain('$3::numeric');
    expect(call.text).toContain('round(');
  });

  it('takes the batch id as $1 and the quantity as $2, in that order', async () => {
    const { sql, calls } = recorder();

    await setBatchQuantity(sql, BATCH, 40);

    const call = onlyCall(calls);
    // A trap worth pinning: the arguments are (batchId, quantity) and the
    // placeholders are $1 for the id in the WHERE and $2 for the quantity in the
    // SET, so the SET clause reads `quantity = $2` before `where id = $1`. Swapping
    // them sets the quantity to a uuid and filters on 40.
    expect(call.text).toContain('set quantity = $2 where id = $1');
    expect(call.params).toEqual([BATCH, 40]);
  });

  it('writes all ten ledger columns, including the optional sale id', async () => {
    const { sql, calls } = recorder();

    await insertMovement(sql, {
      pharmacyId: PHARMACY,
      inventoryId: PRODUCT,
      batchId: BATCH,
      movementType: 'receive',
      quantityChange: 100,
      quantityAfter: 100,
      reason: 'Delivery',
      note: 'Invoice 4411',
      performedBy: OWNER,
    });

    const call = onlyCall(calls);
    expect(call.text).toBe(
      'insert into stock_movements (pharmacy_id, inventory_id, batch_id, sale_id, ' +
        'movement_type, quantity_change, quantity_after, reason, note, performed_by) ' +
        'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)'
    );
    // `saleId` was not supplied and travels as null rather than being omitted, so
    // the column count cannot depend on the caller's options.
    expect(call.params).toEqual([
      PHARMACY, PRODUCT, BATCH, null, 'receive', 100, 100, 'Delivery', 'Invoice 4411', OWNER,
    ]);
    // No `created_at` in the list: migration 0002 set that column's default to
    // clock_timestamp() precisely so the ledger orders itself.
    expect(call.text).not.toContain('created_at');
  });

  it('reads the ledger newest first, with the performer named', async () => {
    const { sql, calls } = recorder();

    await listMovements(sql, PHARMACY, PRODUCT, 50);

    const text = onlyCall(calls).text;
    expect(text).toContain('order by m.created_at desc, m.id desc');
    expect(text).toContain('u.full_name as performed_by_name');
    expect(onlyCall(calls).params).toEqual([PHARMACY, PRODUCT, 50]);
  });
});

describe('recallTrace', () => {
  it('scopes through the sale, because the junction table has no pharmacy of its own', async () => {
    const { sql, calls } = recorder();

    await recallTrace(sql, PHARMACY, BATCH);

    const text = onlyCall(calls).text;
    // `sale_item_batches` carries no pharmacy_id, so a batch id from another
    // pharmacy would answer here without this predicate.
    expect(text).toContain('where sib.batch_id = $1 and s.pharmacy_id = $2');
    expect(onlyCall(calls).params).toEqual([BATCH, PHARMACY]);
  });

  it('does not filter on sale status, so a voided sale is still traced', async () => {
    const { sql, calls } = recorder();

    await recallTrace(sql, PHARMACY, BATCH);

    // A recall is a safety operation and quietly dropping records is the wrong
    // default: a void usually means the goods came back, but "usually" is not
    // something to act on when the question is who may have taken a recalled lot.
    // ASSERT 10f of the harness proves the voided row does come back.
    //
    // Scoped to the WHERE clause, because the SELECT list carries `s.status` and
    // must: the pharmacist reading a recall list needs to be told that a sale was
    // voided, which is different from not being told about it at all.
    const whereClause = onlyCall(calls).text.split(' where ')[1] ?? '';
    expect(whereClause).not.toContain('status');
  });

  it('keeps the patient optional, because a counter sale has none', async () => {
    const { sql, calls } = recorder();

    await recallTrace(sql, PHARMACY, BATCH);

    // A plain join on patients would drop every walk-in sale from a recall list,
    // which is most of them and exactly the ones with no record of who to contact.
    expect(onlyCall(calls).text).toContain('left join patients p on p.id = s.patient_id');
  });

  it('maps the trace row, including the contact details', async () => {
    const { sql, queueRows } = recorder();
    // `fakeRow` defaults `sale_id` to null, which is right for the ledger — a
    // receive has no sale — and wrong here, where it comes from `s.id` and is
    // never null. One row wide enough for every mapper has two meanings for that
    // column, so this test has to say which one it wants.
    queueRows([fakeRow({ sale_id: SALE })]);

    const rows = await recallTrace(sql, PHARMACY, BATCH);

    expect(rows).toEqual([
      {
        saleId: SALE,
        saleNumber: 'S-0001',
        status: 'completed',
        soldAt: '2026-03-15T09:00:00.000Z',
        units: 4,
        unitCost: '8.2500',
        description: 'Paracetamol 500mg x 10',
        sellUnit: 'single',
        servedBy: 'Ama Mensah',
        patientName: 'Kofi Asare',
        patientPhone: '0244000000',
      },
    ]);
  });
});

describe('unique violations', () => {
  const NEW_BATCH = {
    pharmacyId: PHARMACY,
    inventoryId: PRODUCT,
    lotNumber: 'LOT-1',
    expiryDate: '2027-01-31',
    quantity: 100,
    costPrice: '8.2500',
    receivedAt: '2026-03-15T09:00:00.000Z',
  };

  function duplicateKey(): unknown {
    return Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
  }

  it('translates a duplicate product code into a 409', async () => {
    const { sql, queueError } = recorder();
    queueError(duplicateKey());

    const error = await createProduct(sql, NEW_PRODUCT).catch((caught: unknown) => caught);

    // The clash can only be discovered by attempting the insert: pre-checking with
    // a select is raceable and would let two people typing the same code both pass.
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    expect((error as HttpError).code).toBe('product_code_taken');
  });

  it('translates a duplicate lot into a 409', async () => {
    const { sql, queueError } = recorder();
    queueError(duplicateKey());

    const error = await insertBatch(sql, NEW_BATCH).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    expect((error as HttpError).code).toBe('lot_taken');
  });

  it('rethrows any other database error unchanged', async () => {
    // Swallowing a connection failure as "code taken" would tell the pharmacist to
    // pick a different code when the real problem is that the database is down,
    // and they would retry forever.
    const { sql, queueError } = recorder();
    const original = Object.assign(new Error('connection terminated unexpectedly'), {
      code: '08006',
    });
    // One queued error is consumed by the first call, so the second needs its own.
    // Queueing one and asserting two is how this test came to pass a row back from
    // `insertBatch` instead of throwing — a false green on the more dangerous half.
    queueError(original);
    queueError(original);

    await expect(createProduct(sql, NEW_PRODUCT)).rejects.toBe(original);
    await expect(insertBatch(sql, NEW_BATCH)).rejects.toBe(original);
  });

  it('fails loudly if an INSERT ... RETURNING produces no row', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // Reporting null here would make the service answer 201 with no product in
    // the body, and the caller would go on to receive stock against an id it
    // does not have.
    await expect(createProduct(sql, NEW_PRODUCT)).rejects.toThrow(/returned no row/);
  });
});

describe('no value ever reaches the statement as text', () => {
  // Parameter binding is the whole defence against injection, and it is easy to
  // lose by accident: a template literal that grows a `${value}` while somebody is
  // debugging compiles, runs, and works in every test that passes a normal lot
  // number. These values are chosen so that any one of them appearing in a
  // statement is visible.
  const hostile = `'; drop table inventory; --`;
  const hostileText = `O'Brien+" 50% _ \\`;

  it('keeps every supplied value in the parameter list', async () => {
    const calls = (await (async () => {
      const { sql, calls: recorded } = recorder();

      await listProducts(sql, hostile, { search: hostileText, category: hostileText, limit: 5, offset: 0 });
      await findProductById(sql, hostile, hostileText);
      await findProductByCode(sql, hostile, hostileText);
      await lockProduct(sql, hostile, hostileText);
      await createProduct(sql, {
        ...NEW_PRODUCT,
        pharmacyId: hostile,
        name: hostileText,
        code: hostileText,
        shelfLocation: hostileText,
        barcode: hostileText,
      });
      await updateProduct(sql, hostile, hostileText, {
        name: hostileText,
        manufacturer: hostileText,
        barcode: hostileText,
      });
      await listBatchesForProduct(sql, hostile, hostileText);
      await findBatchByLot(sql, hostile, hostileText, hostileText);
      await insertBatch(sql, {
        pharmacyId: hostile,
        inventoryId: hostileText,
        lotNumber: hostileText,
        expiryDate: null,
        quantity: 1,
        costPrice: '1.0000',
        receivedAt: '2026-03-15T09:00:00.000Z',
      });
      await mergeIntoBatch(sql, hostileText, 1, hostileText);
      await setBatchQuantity(sql, hostileText, 1);
      await insertMovement(sql, {
        pharmacyId: hostile,
        inventoryId: hostileText,
        batchId: hostileText,
        movementType: 'adjust',
        quantityChange: -1,
        quantityAfter: 0,
        reason: hostileText,
        note: hostileText,
        performedBy: hostile,
      });
      await listMovements(sql, hostile, hostileText, 5);
      await recallTrace(sql, hostile, hostileText);

      return recorded;
    })());

    expect(calls.length).toBeGreaterThan(0);

    const leaked = calls.filter(
      (call) => call.text.includes('drop table') || call.text.includes(hostileText)
    );
    expect(leaked.map((call) => call.text)).toEqual([]);

    // And positively: the values did travel, as parameters.
    const allParams = calls.flatMap((call) => call.params);
    expect(allParams).toContain(hostile);
    expect(allParams).toContain(hostileText);
  });

  it('binds the enum values as parameters rather than splicing them in', async () => {
    const { sql, calls } = recorder();

    await updateProduct(sql, PHARMACY, PRODUCT, { vatTreatment: 'standard', defaultSellUnit: 'pack' });
    await insertMovement(sql, {
      pharmacyId: PHARMACY,
      inventoryId: PRODUCT,
      batchId: BATCH,
      movementType: 'write_off',
      quantityChange: -5,
      quantityAfter: 0,
      reason: 'Expired',
      note: null,
      performedBy: OWNER,
    });

    // `'standard'` and `'write_off'` as literals would mean the value was
    // interpolated. They travel as parameters and Postgres deduces the enum type
    // from the target column — which is what section 10a's PREPARE proves parses.
    const quoted = calls.flatMap((call) => [...call.text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    expect(quoted).toEqual([]);
    expect(calls.flatMap((call) => call.params)).toEqual(
      expect.arrayContaining(['standard', 'pack', 'write_off'])
    );
  });

  it('leaves no quoted literal in any statement the repository can emit', async () => {
    const calls = await everyStatementShape();

    // The test above drives two statements, and that was the whole of its
    // coverage: adding `and s.status = 'completed'` to recallTrace passed it. That
    // literal silently narrows a recall list to sales nobody voided, which is the
    // exact wrong answer for a safety operation, and nothing said so. Seen happen.
    //
    // Its regex was narrow too — `[a-z_]+` would not match `'2027-01-31'` or
    // `'LOT-1'`, so a spliced date or lot number sailed through as well.
    //
    // There is no legitimate quoted literal anywhere in this repository: every
    // value is bound and Postgres deduces the enum type from the target column.
    const quoted = calls.flatMap((call) =>
      [...call.text.matchAll(/'([^']*)'/g)].map((match) => `'${match[1]}' in: ${call.text}`)
    );
    expect(quoted).toEqual([]);
  });
});

describe('the Postgres harness carries these same statements', () => {
  // Pinning SQL as text proves the repository builds what we intend, and nothing
  // more: it cannot tell us Postgres accepts it. That is what section 10 of
  // `database/tests/assertions.sql` is for, which PREPAREs each of these
  // statements against a real server and then runs the merge, the recall trace
  // and the void restore for real.
  //
  // But section 10 holds a copy. Left alone it drifts: somebody edits the
  // repository, the harness keeps preparing the old statement, and it goes on
  // reporting PASS while proving nothing about the code that ships. This is the
  // tie between the two halves, in both directions.
  const harnessPath = path.resolve(
    __dirname, '..', '..', '..', 'database', 'tests', 'assertions.sql'
  );

  /** The normalised body of every `prepare inventory_repo_* as ...;` in the harness. */
  function harnessStatements(): Set<string> {
    const source = fs.readFileSync(harnessPath, 'utf8');
    // Scoped to this repository's prefix. Section 9 prepares the users
    // repository's statements and section 6 prepares a sales statement; counting
    // those as ours would let a stale inventory statement hide among them.
    const bodies = [...source.matchAll(/prepare\s+inventory_repo_\w+\s+as\s+([\s\S]*?);/g)].map(
      (match) => match[1]
    );
    if (bodies.length === 0) {
      throw new Error(
        `no \`prepare inventory_repo_* as\` statements found in ${harnessPath}; section 10 of ` +
          'the harness is how these statements are proven to parse against real Postgres, so ' +
          'restore it rather than deleting this test'
      );
    }
    return new Set(bodies.map((body) => normalise(body ?? '')));
  }

  it('proves each of them against the harness, and fails naming any it has lost', async () => {
    const statements = (await everyStatementShape()).map((call) => call.text);
    const harness = harnessStatements();

    // Guarding the guard: if the drive stopped issuing statements, the comparison
    // below would pass against nothing. The same drive backs the derived-column
    // scan, so the two guards now fail together rather than one drifting past the
    // other — which is what happened when this describe had its own copy of it.
    expect(statements.length).toBeGreaterThanOrEqual(20);

    const missing = [...new Set(statements)].filter((statement) => !harness.has(statement));
    expect(missing).toEqual([]);
  });

  it('has no prepared statement in the harness that the repository no longer emits', async () => {
    const statements = new Set((await everyStatementShape()).map((call) => call.text));
    const harness = harnessStatements();

    // The other direction. A prepared statement left behind after the repository
    // changed would keep the harness green for a shape nothing produces, and the
    // real shape would go unproven.
    const stale = [...harness].filter((statement) => !statements.has(statement));
    expect(stale).toEqual([]);
  });
});
