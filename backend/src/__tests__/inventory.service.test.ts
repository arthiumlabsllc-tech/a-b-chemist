jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
}));

jest.mock('../repositories/inventory.repository', () => ({
  createProduct: jest.fn(),
  findBatch: jest.fn(),
  findBatchByLot: jest.fn(),
  findProductById: jest.fn(),
  insertBatch: jest.fn(),
  insertMovement: jest.fn(),
  listBatchesForProduct: jest.fn(),
  listMovements: jest.fn(),
  listProducts: jest.fn(),
  lockProduct: jest.fn(),
  mergeIntoBatch: jest.fn(),
  recallTrace: jest.fn(),
  setBatchQuantity: jest.fn(),
  updateProduct: jest.fn(),
}));

import type { PoolClient } from 'pg';
import { poolSql, withTransaction } from '../database/pool';
import {
  createProduct as insertProduct,
  findBatch,
  findBatchByLot,
  findProductById,
  insertBatch,
  insertMovement,
  listBatchesForProduct,
  listMovements as queryMovements,
  listProducts as queryProducts,
  lockProduct,
  mergeIntoBatch,
  recallTrace,
  setBatchQuantity,
  updateProduct as applyProductPatch,
  type BatchRow,
  type MovementRow,
  type NewMovement,
  type ProductRow,
  type RecallSaleRow,
} from '../repositories/inventory.repository';
import * as service from '../services/inventory.service';
import { HttpError } from '../utils/http';

/**
 * The inventory write path, at the service layer.
 *
 * The repositories and the pool are mocked; `utils/fefo` and `utils/coerce` are
 * deliberately not. Those two are the shared rules — the expiry boundary and the
 * "turn whatever arrived into something the database will accept" rules — and
 * stubbing either would assert this service's behaviour against a fiction that
 * agrees with the test. That the repository statements are valid SQL is
 * `inventory.repository.test.ts` and the harness in `database/tests`.
 *
 * Three things this suite exists to prove, because they are the ones that fail
 * silently:
 *
 * - The four derived product columns cannot be written, and what was thrown away
 *   is reported rather than quietly dropped.
 * - Every batch change writes its ledger row on the same client, inside the same
 *   transaction, and the product is re-read afterwards rather than returned from
 *   the lock that predates the change.
 * - Values are coerced *before* the transaction opens, so a rejected field never
 *   costs a row lock.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PHARMACY = 'b0000000-0000-4000-8000-000000000001';
const USER = 'a0000000-0000-4000-8000-000000000002';
const PRODUCT = 'a0000000-0000-4000-8000-000000000010';
const OTHER_PRODUCT = 'a0000000-0000-4000-8000-000000000011';
const BATCH = 'a0000000-0000-4000-8000-000000000020';
const SALE = 'a0000000-0000-4000-8000-000000000030';

const TODAY = '2026-03-15';
/** Five days before TODAY, so it is expired but still on the shelf. */
const EXPIRED = '2026-03-10';
const FUTURE = '2027-01-31';

const ACTOR: service.Actor = { userId: USER, pharmacyId: PHARMACY };

const CLIENT = { query: jest.fn() } as unknown as PoolClient;

/**
 * Typed mocks, via `jest.mocked` rather than an `as jest.Mock` cast.
 *
 * The cast is the idiom used elsewhere in this codebase and it is weaker than it
 * looks: `jest.Mock` has no parameter list, so `mockImplementation` accepts a
 * function of any arity. This file's first run had `insertBatch` implemented as
 * `async (input) => batch({ ...input })` — but the repository's first parameter
 * is the `Sql` handle, so `input` was the client, the spread contributed nothing,
 * and every inserted batch came back holding the fixture default of 100 units
 * instead of the 40 the test had asked for. `jest.mocked` keeps the real
 * signature, which turns that into a compile error instead of a wrong number.
 */
const withTransactionMock = jest.mocked(withTransaction);
const insertProductMock = jest.mocked(insertProduct);
const applyProductPatchMock = jest.mocked(applyProductPatch);
const findProductByIdMock = jest.mocked(findProductById);
const queryProductsMock = jest.mocked(queryProducts);
const lockProductMock = jest.mocked(lockProduct);
const listBatchesForProductMock = jest.mocked(listBatchesForProduct);
const findBatchMock = jest.mocked(findBatch);
const findBatchByLotMock = jest.mocked(findBatchByLot);
const insertBatchMock = jest.mocked(insertBatch);
const mergeIntoBatchMock = jest.mocked(mergeIntoBatch);
const setBatchQuantityMock = jest.mocked(setBatchQuantity);
const insertMovementMock = jest.mocked(insertMovement);
const queryMovementsMock = jest.mocked(queryMovements);
const recallTraceMock = jest.mocked(recallTrace);

/**
 * Complete rows rather than partial ones cast to the interface: if `ProductRow`
 * or `BatchRow` grows a required field, this file stops compiling instead of
 * quietly feeding the service a row no database would ever return.
 */
function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
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
    expiryDate: FUTURE,
    costPrice: '8.2500',
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

function batch(overrides: Partial<BatchRow> = {}): BatchRow {
  return {
    id: BATCH,
    pharmacyId: PHARMACY,
    inventoryId: PRODUCT,
    lotNumber: 'LOT-1',
    expiryDate: FUTURE,
    quantity: 100,
    costPrice: '8.2500',
    receivedAt: '2026-01-05T09:00:00.000Z',
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

function movement(overrides: Partial<MovementRow> = {}): MovementRow {
  return {
    id: 'a0000000-0000-4000-8000-000000000040',
    pharmacyId: PHARMACY,
    inventoryId: PRODUCT,
    batchId: BATCH,
    saleId: null,
    movementType: 'receive',
    quantityChange: 100,
    quantityAfter: 100,
    reason: null,
    note: null,
    performedBy: USER,
    performedByName: 'Beatrice Owusu',
    createdAt: '2026-03-15T09:00:00.000Z',
    ...overrides,
  };
}

function sale(overrides: Partial<RecallSaleRow> = {}): RecallSaleRow {
  return {
    saleId: SALE,
    saleNumber: 'S-0001',
    status: 'completed',
    soldAt: '2026-03-01T10:00:00.000Z',
    units: 4,
    unitCost: '8.2500',
    description: 'Paracetamol 500mg',
    sellUnit: 'single',
    servedBy: USER,
    patientName: 'Ama Mensah',
    patientPhone: '+233201234567',
    ...overrides,
  };
}

/** The last `NewMovement` handed to the ledger, or null when none was. */
function lastMovement(): NewMovement | null {
  const calls = insertMovementMock.mock.calls;
  const last = calls[calls.length - 1];
  return last === undefined ? null : last[1];
}

/**
 * Underscores removed and case folded, so `costPrice`, `cost_price`, `COST_PRICE`
 * and `costprice` are all the same key.
 *
 * The scan below needs this and a plain `toLowerCase()` comparison is not enough:
 * `DERIVED_PRODUCT_FIELDS` is camelCase, so `'batch_number'.toLowerCase()` never
 * equals `'batchNumber'.toLowerCase()` and the snake_case spellings — the ones
 * `splitDerivedFields` exists to catch — would sail straight through the check
 * that is supposed to prove they cannot.
 */
function normalise(key: string): string {
  return key.replace(/_/gu, '').toLowerCase();
}

const DERIVED_MATCH = new Set(service.DERIVED_PRODUCT_FIELDS.map(normalise));

/**
 * Every key, in any object argument of any call, that names a derived product
 * column. Extracted so the anti-vacuity test below exercises the same code as the
 * real check: a second scan written for the test would prove nothing about the
 * first one.
 */
function scanForDerived(writes: readonly unknown[][]): string[] {
  return writes.flatMap((call) =>
    call.flatMap((argument) =>
      typeof argument === 'object' && argument !== null
        ? Object.keys(argument).filter((key) => DERIVED_MATCH.has(normalise(key)))
        : []
    )
  );
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string
): Promise<HttpError> {
  const thrown = await promise.then(
    () => null,
    (error: unknown) => error
  );
  if (!(thrown instanceof HttpError)) {
    throw new Error(
      `expected an HttpError ${status}/${code}, got ` +
        (thrown === null ? 'a promise that resolved' : String(thrown))
    );
  }
  expect(thrown.status).toBe(status);
  expect(thrown.code).toBe(code);
  return thrown;
}

beforeEach(() => {
  // The transaction runs its work with a single fake client. Nothing here issues
  // SQL, because every repository is mocked; the client exists to be identified.
  withTransactionMock.mockImplementation(async (work) => work(CLIENT));

  insertProductMock.mockImplementation(async (_sql, input) => product(input));
  applyProductPatchMock.mockImplementation(async (_sql, _pharmacyId, _id, patch) =>
    product(patch)
  );
  findProductByIdMock.mockResolvedValue(product());
  queryProductsMock.mockResolvedValue([product()]);
  lockProductMock.mockResolvedValue(product());
  listBatchesForProductMock.mockResolvedValue([batch()]);
  findBatchMock.mockResolvedValue(batch());
  findBatchByLotMock.mockResolvedValue(null);
  insertBatchMock.mockImplementation(async (_sql, input) =>
    batch({ ...input, id: 'a0000000-0000-4000-8000-000000000021' })
  );
  mergeIntoBatchMock.mockImplementation(async (_sql, id, quantity, costPrice) =>
    batch({ id, quantity: 100 + quantity, costPrice })
  );
  setBatchQuantityMock.mockImplementation(async (_sql, id, quantity) => batch({ id, quantity }));
  // `insertMovement` returns nothing: the ledger row is written for its own sake
  // and no caller reads it back.
  insertMovementMock.mockResolvedValue(undefined);
  queryMovementsMock.mockResolvedValue([movement()]);
  recallTraceMock.mockResolvedValue([sale()]);
});

describe('splitDerivedFields', () => {
  it('removes every spelling of every derived field and reports the canonical name', () => {
    const { editable, discarded } = service.splitDerivedFields({
      name: 'Paracetamol 500mg',
      quantity: 500,
      batch_number: 'LOT-9',
      expiryDate: '2030-01-01',
      cost_price: '1.0000',
    });

    expect(editable).toEqual({ name: 'Paracetamol 500mg' });
    expect(discarded).toEqual([
      'quantity',
      'batchNumber',
      'expiryDate',
      'costPrice',
    ]);
  });

  it('recognises the compact lower-case spellings too', () => {
    const { editable, discarded } = service.splitDerivedFields({
      BATCHNUMBER: 'LOT-9',
      expirydate: '2030-01-01',
      CostPrice: '1.0000',
    });

    expect(editable).toEqual({});
    expect(discarded).toEqual(['batchNumber', 'expiryDate', 'costPrice']);
  });

  it('reports discarded in the fixed order of DERIVED_PRODUCT_FIELDS, not the order sent', () => {
    const { discarded } = service.splitDerivedFields({
      costPrice: '1.0000',
      expiryDate: '2030-01-01',
      batchNumber: 'LOT-9',
      quantity: 5,
    });

    // A caller reading this list back must get the same order every time, or the
    // UI has to sort it before it can show it.
    expect(discarded).toEqual([...service.DERIVED_PRODUCT_FIELDS]);
  });

  it('does not report a derived field whose value is undefined', () => {
    const { discarded } = service.splitDerivedFields({ quantity: undefined });

    // A JSON body cannot carry `undefined`, so this only arises from a caller
    // building the object itself. Reporting an absent value as discarded would
    // teach the reader to ignore the list.
    expect(discarded).toEqual([]);
  });

  it('counts a falsy derived value as an attempt', () => {
    expect(service.splitDerivedFields({ quantity: 0 }).discarded).toEqual(['quantity']);
    expect(service.splitDerivedFields({ batchNumber: null }).discarded).toEqual(['batchNumber']);
    expect(service.splitDerivedFields({ expiryDate: '' }).discarded).toEqual(['expiryDate']);
    expect(service.splitDerivedFields({ costPrice: false }).discarded).toEqual(['costPrice']);
  });

  it('matches derived names exactly, so a field that merely contains one passes through', () => {
    const { editable, discarded } = service.splitDerivedFields({
      quantityNote: 'counted twice',
      expiryDateLabel: 'best before',
      costPricePerPack: '12.00',
    });

    expect(discarded).toEqual([]);
    expect(Object.keys(editable).sort()).toEqual([
      'costPricePerPack',
      'expiryDateLabel',
      'quantityNote',
    ]);
  });

  it('does not modify the body it was given', () => {
    const body: Record<string, unknown> = { name: 'X', quantity: 5 };
    service.splitDerivedFields(body);

    expect(body).toEqual({ name: 'X', quantity: 5 });
  });
});

describe('resolveReceivedAt', () => {
  it('stamps now when no value was supplied', () => {
    const before = Date.now();
    const resolved = service.resolveReceivedAt(undefined);
    const after = Date.now();

    expect(Date.parse(resolved)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(resolved)).toBeLessThanOrEqual(after);
  });

  it('stamps now for a value that is only whitespace', () => {
    const before = Date.now();
    expect(Date.parse(service.resolveReceivedAt('   '))).toBeGreaterThanOrEqual(before);
  });

  it('accepts an explicit past instant and normalises it to ISO-8601', () => {
    expect(service.resolveReceivedAt('2026-03-01T08:30:00Z')).toBe('2026-03-01T08:30:00.000Z');
  });

  it('refuses an unparseable date', async () => {
    await expectHttpError(
      Promise.resolve().then(() => service.resolveReceivedAt('last tuesday')),
      400,
      'validation_failed'
    );
  });

  it('refuses a future instant, because received_at is the FEFO tie-break', async () => {
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const error = await expectHttpError(
      Promise.resolve().then(() => service.resolveReceivedAt(nextWeek)),
      400,
      'received_at_in_future'
    );

    // A receive dated next week would sort behind every lot that arrived before
    // it and be sold last — the opposite of what the tie-break is for.
    expect(error.message).toContain('future');
  });

  it('refuses even a near-future instant rather than allowing clock drift', async () => {
    const oneSecondAhead = new Date(Date.now() + 1_000).toISOString();
    await expectHttpError(
      Promise.resolve().then(() => service.resolveReceivedAt(oneSecondAhead)),
      400,
      'received_at_in_future'
    );
  });

  it('accepts an instant one second in the past', () => {
    const oneSecondAgo = new Date(Date.now() - 1_000).toISOString();
    expect(service.resolveReceivedAt(oneSecondAgo)).toBe(oneSecondAgo);
  });
});

describe('createProduct', () => {
  it('applies the documented defaults for every field the caller omitted', async () => {
    await service.createProduct(ACTOR, { name: 'Paracetamol 500mg', code: 'PARA-500' });

    expect(insertProductMock.mock.calls[0]?.[1]).toEqual({
      pharmacyId: PHARMACY,
      name: 'Paracetamol 500mg',
      code: 'PARA-500',
      genericName: null,
      category: null,
      manufacturer: null,
      packSize: 1,
      defaultSellUnit: 'single',
      shelfLocation: null,
      barcode: null,
      requiresPrescription: false,
      reorderLevel: 0,
      unitPrice: '0',
      vatTreatment: 'exempt',
      isActive: true,
    });
  });

  it('reports what it discarded, and the derived list alongside it', async () => {
    const result = await service.createProduct(ACTOR, {
      name: 'Paracetamol 500mg',
      code: 'PARA-500',
      quantity: 999,
      cost_price: '1.0000',
    });

    expect(result.discarded).toEqual(['quantity', 'costPrice']);
    expect(service.DERIVED_PRODUCT_FIELDS).toHaveLength(4);
  });
});

describe('updateProduct', () => {
  it('names every editable field explicitly, so nothing unlisted reaches the patch', async () => {
    await service.updateProduct(ACTOR, PRODUCT, {
      name: 'Renamed',
      // All four derived columns, in both conventions, plus a key that is not a
      // field of anything.
      quantity: 500,
      batch_number: 'LOT-9',
      expiryDate: '2030-01-01',
      costPrice: '1.0000',
      isAdmin: true,
      pharmacyId: OTHER_PHARMACY,
      id: OTHER_PRODUCT,
    });

    // Exact equality is the whole assertion. `toProductPatch` builds the patch by
    // naming fields rather than spreading the body, so this holds even if
    // `splitDerivedFields` were deleted — the two layers are independent, and
    // this is the proof of the second one. `pharmacyId` and `id` matter most: a
    // patch that carried either would move the row to another pharmacy.
    expect(applyProductPatchMock.mock.calls[0]?.[3]).toEqual({ name: 'Renamed' });
  });

  it('still reports the discarded fields even though the patch never held them', async () => {
    const result = await service.updateProduct(ACTOR, PRODUCT, {
      quantity: 500,
      batchNumber: 'LOT-9',
      expiryDate: '2030-01-01',
      costPrice: '1.0000',
    });

    expect(result.discarded).toEqual([...service.DERIVED_PRODUCT_FIELDS]);
  });

  it('sends an empty patch when only derived fields were sent', async () => {
    await service.updateProduct(ACTOR, PRODUCT, { quantity: 500 });

    // The repository issues no UPDATE for an empty patch, which is what keeps a
    // derived-column-only request from touching `updated_at` and looking saved.
    expect(applyProductPatchMock.mock.calls[0]?.[3]).toEqual({});
  });

  it('answers 404 for a product that is not there', async () => {
    applyProductPatchMock.mockResolvedValue(null);

    await expectHttpError(service.updateProduct(ACTOR, PRODUCT, { name: 'X' }), 404, 'not_found');
  });
});

describe('the two writes that reach the inventory table', () => {
  it('hand no derived column to the repository, across every write the service can perform', async () => {
    // Drives everything that can write a product row: create, patch in both
    // conventions, and the three stock operations (which write batches, not
    // products, and are here so that a future edit routing a derived column
    // through one of them is caught).
    //
    // The camelCase patch matters as much as the snake_case one. `DERIVED_SPELLINGS`
    // holds both, and a lookup that stopped folding case would let `batchNumber`
    // through while still catching `batch_number` — which is exactly the failure
    // this pair of calls is arranged to expose.
    await service.createProduct(ACTOR, {
      name: 'A',
      code: 'A-1',
      quantity: 1,
      batchNumber: 'L',
      expiryDate: FUTURE,
      costPrice: '1.0000',
    });
    await service.updateProduct(ACTOR, PRODUCT, {
      name: 'B',
      quantity: 2,
      batchNumber: 'L',
      expiryDate: FUTURE,
      costPrice: '2.0000',
    });
    await service.updateProduct(ACTOR, PRODUCT, {
      name: 'C',
      quantity: 3,
      batch_number: 'L',
      expiry_date: FUTURE,
      cost_price: '3.0000',
    });
    await service.receiveStock(ACTOR, PRODUCT, {
      lotNumber: 'LOT-1',
      quantity: 10,
      costPrice: '3.0000',
      expiryDate: FUTURE,
    });
    await service.adjustBatch(ACTOR, PRODUCT, BATCH, {
      quantity: 5,
      reason: 'Stocktake',
      note: 'Counted',
    });
    await service.writeOffBatch(ACTOR, PRODUCT, BATCH, {
      quantity: 2,
      reason: 'Expired',
      note: 'Pulled',
    });

    // Only these two functions write `inventory`, so only their arguments are
    // scanned. `insertBatch` legitimately carries a `quantity` and `insertMovement`
    // carries `quantityChange`: those are the batch's and the ledger's, not the
    // product's derived column, and a blanket scan would drown the real check.
    const writes: unknown[][] = [
      ...insertProductMock.mock.calls,
      ...applyProductPatchMock.mock.calls,
    ];
    // One create and two patches. Counted rather than `> 0`, so a change that
    // silently stops driving one of the three shapes fails here instead of
    // narrowing the scan without saying so.
    expect(writes).toHaveLength(3);
    expect(scanForDerived(writes)).toEqual([]);
  });

  it('would notice a derived column if one arrived', () => {
    // Anti-vacuity, and the reason `scanForDerived` is a function rather than an
    // inline filter. The obvious way to write this check compares each key against
    // `DERIVED_PRODUCT_FIELDS` with `toLowerCase()` on both sides, which matches
    // `costPrice` and misses `cost_price` — the spelling `splitDerivedFields`
    // exists to catch. Fed known-bad input, that version returns a short list and
    // the real test still passes.
    const bad: unknown[][] = [
      [
        // The `Sql` handle goes in first, as it does in every real call, to prove
        // the scan does not report it.
        { query: jest.fn() },
        { name: 'X', cost_price: '1.0000', BATCHNUMBER: 'L', expiry_date: FUTURE, quantity: 9 },
      ],
    ];

    expect(scanForDerived(bad).sort()).toEqual([
      'BATCHNUMBER',
      'cost_price',
      'expiry_date',
      'quantity',
    ]);
  });
});

describe('receiveStock', () => {
  it('coerces before the transaction opens, so a rejected value costs no row lock', async () => {
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

    await expectHttpError(
      service.receiveStock(ACTOR, PRODUCT, {
        lotNumber: 'LOT-1',
        quantity: 10,
        costPrice: '3.0000',
        expiryDate: FUTURE,
        receivedAt: nextWeek,
      }),
      400,
      'received_at_in_future'
    );

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(lockProductMock).not.toHaveBeenCalled();
  });

  it('refuses a quantity below the minimum before locking anything', async () => {
    await expectHttpError(
      service.receiveStock(ACTOR, PRODUCT, {
        lotNumber: 'LOT-1',
        quantity: 0,
        costPrice: '3.0000',
        expiryDate: FUTURE,
      }),
      400,
      'validation_failed'
    );

    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('creates a batch when the lot is new, and says it was not a merge', async () => {
    findBatchByLotMock.mockResolvedValue(null);

    const result = await service.receiveStock(ACTOR, PRODUCT, {
      lotNumber: 'LOT-2',
      quantity: 40,
      costPrice: '9.5000',
      expiryDate: FUTURE,
    });

    expect(result.merged).toBe(false);
    expect(insertBatchMock).toHaveBeenCalledTimes(1);
    expect(mergeIntoBatchMock).not.toHaveBeenCalled();
    expect(insertBatchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        pharmacyId: PHARMACY,
        inventoryId: PRODUCT,
        lotNumber: 'LOT-2',
        expiryDate: FUTURE,
        quantity: 40,
        costPrice: '9.5000',
      })
    );
  });

  it('merges into the existing batch when the lot matches, and says it was a merge', async () => {
    findBatchByLotMock.mockResolvedValue(batch({ quantity: 100 }));

    const result = await service.receiveStock(ACTOR, PRODUCT, {
      lotNumber: 'LOT-1',
      quantity: 40,
      costPrice: '9.5000',
      expiryDate: FUTURE,
    });

    expect(result.merged).toBe(true);
    expect(insertBatchMock).not.toHaveBeenCalled();
    expect(mergeIntoBatchMock).toHaveBeenCalledWith(CLIENT, BATCH, 40, '9.5000');
    expect(result.batch.quantity).toBe(140);
    expect(result.quantityAfter).toBe(140);
  });

  it('refuses to merge when the expiry differs, and writes no ledger row', async () => {
    findBatchByLotMock.mockResolvedValue(batch({ expiryDate: FUTURE }));

    const error = await expectHttpError(
      service.receiveStock(ACTOR, PRODUCT, {
        lotNumber: 'LOT-1',
        quantity: 40,
        costPrice: '9.5000',
        expiryDate: '2028-06-30',
      }),
      409,
      'lot_expiry_conflict'
    );

    // Silently moving the date would apply the new one to stock received under
    // the old, so the message has to say which lot and which two dates.
    expect(error.message).toContain('LOT-1');
    expect(error.message).toContain(FUTURE);
    expect(error.message).toContain('2028-06-30');
    expect(mergeIntoBatchMock).not.toHaveBeenCalled();
    expect(insertBatchMock).not.toHaveBeenCalled();
    expect(insertMovementMock).not.toHaveBeenCalled();
  });

  it('refuses to merge a dated lot into an undated one', async () => {
    findBatchByLotMock.mockResolvedValue(batch({ expiryDate: null }));

    await expectHttpError(
      service.receiveStock(ACTOR, PRODUCT, {
        lotNumber: 'LOT-1',
        quantity: 40,
        costPrice: '9.5000',
        expiryDate: FUTURE,
      }),
      409,
      'lot_expiry_conflict'
    );
  });

  it('merges when both the existing lot and the arrival are undated', async () => {
    findBatchByLotMock.mockResolvedValue(batch({ expiryDate: null, quantity: 100 }));

    const result = await service.receiveStock(ACTOR, PRODUCT, {
      lotNumber: 'LOT-1',
      quantity: 40,
      costPrice: '9.5000',
      expiryDate: null,
    });

    expect(result.merged).toBe(true);
    expect(mergeIntoBatchMock).toHaveBeenCalledTimes(1);
  });

  it('writes the ledger row with a positive change and the batch quantity after', async () => {
    findBatchByLotMock.mockResolvedValue(null);

    await service.receiveStock(ACTOR, PRODUCT, {
      lotNumber: 'LOT-2',
      quantity: 40,
      costPrice: '9.5000',
      expiryDate: FUTURE,
      reason: 'Delivery 12',
      note: 'From supplier',
    });

    expect(lastMovement()).toEqual(
      expect.objectContaining({
        pharmacyId: PHARMACY,
        inventoryId: PRODUCT,
        batchId: 'a0000000-0000-4000-8000-000000000021',
        saleId: null,
        movementType: 'receive',
        quantityChange: 40,
        quantityAfter: 40,
        reason: 'Delivery 12',
        note: 'From supplier',
        performedBy: USER,
      })
    );
  });

  it('records a null reason and note when the caller sent neither', async () => {
    await service.receiveStock(ACTOR, PRODUCT, {
      lotNumber: 'LOT-2',
      quantity: 40,
      costPrice: '9.5000',
      expiryDate: FUTURE,
    });

    expect(lastMovement()).toEqual(expect.objectContaining({ reason: null, note: null }));
  });

  it('re-reads the product after the write instead of returning the copy taken by the lock', async () => {
    // The locked row is stale by construction: it was read before the batch
    // existed, so its derived columns still describe the shelf as it was.
    lockProductMock.mockResolvedValue(
      product({ quantity: 0, batchNumber: null, expiryDate: null, costPrice: '0.0000' })
    );
    findProductByIdMock.mockResolvedValue(
      product({ quantity: 40, batchNumber: 'LOT-2', expiryDate: FUTURE, costPrice: '9.5000' })
    );

    const result = await service.receiveStock(ACTOR, PRODUCT, {
      lotNumber: 'LOT-2',
      quantity: 40,
      costPrice: '9.5000',
      expiryDate: FUTURE,
    });

    expect(result.product.quantity).toBe(40);
    expect(result.product.batchNumber).toBe('LOT-2');
    // And the re-read happens on the transaction's client, not on the pool.
    expect(findProductByIdMock).toHaveBeenCalledWith(CLIENT, PHARMACY, PRODUCT);
  });

  it('answers 404 for a product that is not there, writing nothing', async () => {
    lockProductMock.mockResolvedValue(null);

    await expectHttpError(
      service.receiveStock(ACTOR, PRODUCT, {
        lotNumber: 'LOT-2',
        quantity: 40,
        costPrice: '9.5000',
        expiryDate: FUTURE,
      }),
      404,
      'not_found'
    );

    expect(insertBatchMock).not.toHaveBeenCalled();
    expect(insertMovementMock).not.toHaveBeenCalled();
  });

  it('runs every read and every write on the transaction client, never on the pool', async () => {
    findBatchByLotMock.mockResolvedValue(batch({ quantity: 100 }));

    await service.receiveStock(ACTOR, PRODUCT, {
      lotNumber: 'LOT-1',
      quantity: 40,
      costPrice: '9.5000',
      expiryDate: FUTURE,
    });

    // Atomicity is a property of which handle each statement went to. A write on
    // `poolSql` would commit on its own, so a later failure in the transaction
    // would leave the batch moved and the ledger row missing.
    const inside = [
      lockProductMock,
      findBatchByLotMock,
      mergeIntoBatchMock,
      insertMovementMock,
      findProductByIdMock,
    ];
    for (const mock of inside) {
      expect(mock).toHaveBeenCalled();
      const calls = mock.mock.calls as unknown as unknown[][];
      for (const call of calls) {
        expect(call[0]).toBe(CLIENT);
        expect(call[0]).not.toBe(poolSql);
      }
    }
  });
});

describe('adjustBatch', () => {
  it('refuses an adjustment to the quantity the batch already holds', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 100 }));

    const error = await expectHttpError(
      service.adjustBatch(ACTOR, PRODUCT, BATCH, {
        quantity: 100,
        reason: 'Stocktake',
        note: 'Counted',
      }),
      400,
      'no_change'
    );

    // The ledger checks `quantity_change <> 0` and would fail anyway — as a
    // database error rather than as a sentence the person can act on.
    expect(error.message).toContain('100');
    expect(setBatchQuantityMock).not.toHaveBeenCalled();
    expect(insertMovementMock).not.toHaveBeenCalled();
  });

  it('accepts a counted quantity of zero, which PRODUCT_LIMITS.quantity does not', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 100 }));

    const result = await service.adjustBatch(ACTOR, PRODUCT, BATCH, {
      quantity: 0,
      reason: 'Stocktake',
      note: 'Shelf was empty',
    });

    // A stocktake that finds an empty box is an adjustment. Refusing it would
    // send the pharmacist to the write-off form to describe something that was
    // counted rather than damaged.
    expect(service.PRODUCT_LIMITS.quantity.min).toBe(1);
    expect(result.quantityChange).toBe(-100);
    expect(result.quantityAfter).toBe(0);
    expect(setBatchQuantityMock).toHaveBeenCalledWith(CLIENT, BATCH, 0);
  });

  it('records the difference, signed, rather than the destination', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 100 }));

    await service.adjustBatch(ACTOR, PRODUCT, BATCH, {
      quantity: 92,
      reason: 'Stocktake',
      note: 'Counted 92',
    });

    expect(lastMovement()).toEqual(
      expect.objectContaining({
        movementType: 'adjust',
        quantityChange: -8,
        quantityAfter: 92,
        reason: 'Stocktake',
        note: 'Counted 92',
        performedBy: USER,
      })
    );
  });

  it('records a positive difference when the count is higher than the book', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 100 }));

    const result = await service.adjustBatch(ACTOR, PRODUCT, BATCH, {
      quantity: 104,
      reason: 'Stocktake',
      note: 'Found four',
    });

    expect(result.quantityChange).toBe(4);
    expect(lastMovement()?.quantityChange).toBe(4);
  });

  it('answers 404 for a batch that belongs to a different product', async () => {
    findBatchMock.mockResolvedValue(batch({ inventoryId: OTHER_PRODUCT }));

    const error = await expectHttpError(
      service.adjustBatch(ACTOR, PRODUCT, BATCH, {
        quantity: 10,
        reason: 'Stocktake',
        note: 'Counted',
      }),
      404,
      'not_found'
    );

    // The same message as for a batch that does not exist at all. Distinguishing
    // them would let a caller enumerate ids that exist under another product.
    expect(error.message).toBe('No batch matches that id');
    expect(setBatchQuantityMock).not.toHaveBeenCalled();
  });

  it('coerces the counted quantity before the transaction opens', async () => {
    await expectHttpError(
      service.adjustBatch(ACTOR, PRODUCT, BATCH, {
        quantity: 'not a number',
        reason: 'Stocktake',
        note: 'Counted',
      }),
      400,
      'validation_failed'
    );

    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

describe('writeOffBatch', () => {
  it('writes off the whole batch when no quantity is given', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 30 }));

    const result = await service.writeOffBatch(ACTOR, PRODUCT, BATCH, {
      reason: 'Expired',
      note: 'Pulled from shelf',
    });

    expect(result.quantityChange).toBe(-30);
    expect(result.quantityAfter).toBe(0);
    expect(setBatchQuantityMock).toHaveBeenCalledWith(CLIENT, BATCH, 0);
  });

  it('refuses an empty batch', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 0 }));

    const error = await expectHttpError(
      service.writeOffBatch(ACTOR, PRODUCT, BATCH, { reason: 'Expired', note: 'Pulled' }),
      400,
      'batch_empty'
    );

    expect(error.message).toContain('no stock');
    expect(setBatchQuantityMock).not.toHaveBeenCalled();
    expect(insertMovementMock).not.toHaveBeenCalled();
  });

  it('refuses to write off more than the batch holds', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 30 }));

    const error = await expectHttpError(
      service.writeOffBatch(ACTOR, PRODUCT, BATCH, {
        quantity: 31,
        reason: 'Expired',
        note: 'Pulled',
      }),
      400,
      'exceeds_batch_quantity'
    );

    expect(error.message).toContain('30');
    expect(error.message).toContain('31');
    expect(setBatchQuantityMock).not.toHaveBeenCalled();
  });

  it('records a negative change, because the ledger sign is what makes it summable', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 30 }));

    await service.writeOffBatch(ACTOR, PRODUCT, BATCH, {
      quantity: 12,
      reason: 'Damaged',
      note: 'Crushed in transit',
    });

    expect(lastMovement()).toEqual(
      expect.objectContaining({
        movementType: 'write_off',
        quantityChange: -12,
        quantityAfter: 18,
        reason: 'Damaged',
        note: 'Crushed in transit',
      })
    );
  });

  it('leaves the batch row in place at zero rather than deleting it', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 30 }));

    await service.writeOffBatch(ACTOR, PRODUCT, BATCH, { reason: 'Expired', note: 'Pulled' });

    // Deleting the row would break the `sale_item_batches` rows pointing at it,
    // and those rows are the recall trail for sales already made.
    expect(setBatchQuantityMock).toHaveBeenCalledWith(CLIENT, BATCH, 0);
    expect(insertMovementMock).toHaveBeenCalledTimes(1);
  });

  it('coerces the quantity before the transaction opens', async () => {
    await expectHttpError(
      service.writeOffBatch(ACTOR, PRODUCT, BATCH, {
        quantity: 'twelve',
        reason: 'Expired',
        note: 'Pulled',
      }),
      400,
      'validation_failed'
    );

    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('does not coerce at all when the quantity is omitted', async () => {
    findBatchMock.mockResolvedValue(batch({ quantity: 30 }));

    await service.writeOffBatch(ACTOR, PRODUCT, BATCH, { reason: 'Expired', note: 'Pulled' });

    // `undefined` means "the whole batch", which is not known until the row is
    // read under the lock, so it must not be sent through the integer coercer.
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(setBatchQuantityMock).toHaveBeenCalledWith(CLIENT, BATCH, 0);
  });

  it('answers 404 for a batch that belongs to a different product', async () => {
    findBatchMock.mockResolvedValue(batch({ inventoryId: OTHER_PRODUCT }));

    await expectHttpError(
      service.writeOffBatch(ACTOR, PRODUCT, BATCH, { reason: 'Expired', note: 'Pulled' }),
      404,
      'not_found'
    );
  });
});

describe('contactsFor', () => {
  it('groups two sales to the same phone into one contact that counts two', () => {
    const { contacts, untraceableSales } = service.contactsFor([
      sale({ saleId: 'a0000000-0000-4000-8000-000000000031' }),
      sale({ saleId: 'a0000000-0000-4000-8000-000000000032' }),
    ]);

    // Calling the same person twice is not a better recall.
    expect(contacts).toEqual([{ name: 'Ama Mensah', phone: '+233201234567', sales: 2 }]);
    expect(untraceableSales).toBe(0);
  });

  it('keeps two different phone numbers as two contacts', () => {
    const { contacts } = service.contactsFor([
      sale({ patientPhone: '+233201234567' }),
      sale({ patientName: 'Kojo Antwi', patientPhone: '+233209876543' }),
    ]);

    expect(contacts).toHaveLength(2);
    expect(contacts.every((contact) => contact.sales === 1)).toBe(true);
  });

  it('groups by name when there is no phone number', () => {
    const { contacts } = service.contactsFor([
      sale({ patientName: 'Efua Boakye', patientPhone: null }),
      sale({ patientName: 'Efua Boakye', patientPhone: null }),
    ]);

    expect(contacts).toEqual([{ name: 'Efua Boakye', phone: null, sales: 2 }]);
  });

  it('does not merge a phone-holder with a name-only patient who shares the name', () => {
    const { contacts } = service.contactsFor([
      sale({ patientName: 'Ama Mensah', patientPhone: '+233201234567' }),
      sale({ patientName: 'Ama Mensah', patientPhone: null }),
    ]);

    // Different buckets by design: one is reachable and one is not, and folding
    // them together would report a contact the recall cannot actually call.
    expect(contacts).toHaveLength(2);
  });

  it('counts a sale with neither name nor phone as untraceable, not as a contact', () => {
    const { contacts, untraceableSales } = service.contactsFor([
      sale(),
      sale({ patientName: null, patientPhone: null }),
      sale({ patientName: null, patientPhone: null }),
    ]);

    // A counter sale to a walk-in genuinely cannot be traced, and a recall that
    // reports one contact without mentioning the two untraceable sales overstates
    // what was achieved.
    expect(contacts).toHaveLength(1);
    expect(untraceableSales).toBe(2);
  });

  it('counts a phone with no name as traceable, and labels it', () => {
    const { contacts, untraceableSales } = service.contactsFor([
      sale({ patientName: null, patientPhone: '+233201234567' }),
    ]);

    expect(untraceableSales).toBe(0);
    expect(contacts).toEqual([
      { name: 'Patient name not recorded', phone: '+233201234567', sales: 1 },
    ]);
  });

  it('counts a name with no phone as traceable, and does not label it', () => {
    const { contacts, untraceableSales } = service.contactsFor([
      sale({ patientName: 'Efua Boakye', patientPhone: null }),
    ]);

    expect(untraceableSales).toBe(0);
    expect(contacts).toEqual([{ name: 'Efua Boakye', phone: null, sales: 1 }]);
  });

  it('puts phone-holders first, then sorts each group by name', () => {
    const { contacts } = service.contactsFor([
      sale({ patientName: 'Zoe', patientPhone: null }),
      sale({ patientName: 'Abel', patientPhone: '+233200000002' }),
      sale({ patientName: 'Adam', patientPhone: null }),
      sale({ patientName: 'Bea', patientPhone: '+233200000001' }),
    ]);

    // Within the phone group the order is by name, not by phone: Bea holds the
    // lower number and still comes second, so a tie-break changed to phone would
    // fail here. Phone-holders as a group come first, because they are the ones a
    // recall can actually reach.
    expect(contacts.map((contact) => contact.name)).toEqual(['Abel', 'Bea', 'Adam', 'Zoe']);
    expect(contacts.map((contact) => contact.phone !== null)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('answers with no contacts and nothing untraceable for an empty trace', () => {
    expect(service.contactsFor([])).toEqual({ contacts: [], untraceableSales: 0 });
  });
});

describe('recallBatch', () => {
  it('returns the trace, the contacts and the untraceable count together', async () => {
    recallTraceMock.mockResolvedValue([
      sale(),
      sale({ patientName: null, patientPhone: null }),
    ]);

    const result = await service.recallBatch(PHARMACY, PRODUCT, BATCH);

    expect(result.sales).toHaveLength(2);
    expect(result.contacts).toHaveLength(1);
    expect(result.untraceableSales).toBe(1);
    expect(result.product.id).toBe(PRODUCT);
    expect(result.batch.id).toBe(BATCH);
  });

  it('answers 404 for a batch that belongs to a different product', async () => {
    findBatchMock.mockResolvedValue(batch({ inventoryId: OTHER_PRODUCT }));

    await expectHttpError(
      service.recallBatch(PHARMACY, PRODUCT, BATCH),
      404,
      'not_found'
    );

    expect(recallTraceMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a product that is not there', async () => {
    findProductByIdMock.mockResolvedValue(null);

    await expectHttpError(service.recallBatch(PHARMACY, PRODUCT, BATCH), 404, 'not_found');
    expect(findBatchMock).not.toHaveBeenCalled();
  });

  it('reads on the pool, because a recall changes nothing', async () => {
    await service.recallBatch(PHARMACY, PRODUCT, BATCH);

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(recallTraceMock).toHaveBeenCalledWith(poolSql, PHARMACY, BATCH);
  });
});

describe('getProduct', () => {
  it('computes the figures it shows from the batches, not from the derived columns', async () => {
    // One expired lot of 30 and one sellable lot of 70. The derived `quantity`
    // is the physical count and says 100; what may be handed over is 70; and the
    // lot at the front of the shelf is the expired one, which is exactly what the
    // product card must not hide.
    const expiredBatch = batch({
      id: 'a0000000-0000-4000-8000-000000000021',
      lotNumber: 'LOT-OLD',
      expiryDate: EXPIRED,
      quantity: 30,
      receivedAt: '2026-01-05T09:00:00.000Z',
    });
    const sellableBatch = batch({
      id: 'a0000000-0000-4000-8000-000000000022',
      lotNumber: 'LOT-NEW',
      expiryDate: FUTURE,
      quantity: 70,
      receivedAt: '2026-02-05T09:00:00.000Z',
    });

    findProductByIdMock.mockResolvedValue(product({ quantity: 100 }));
    listBatchesForProductMock.mockResolvedValue([sellableBatch, expiredBatch]);

    const detail = await service.getProduct(PHARMACY, PRODUCT, TODAY);

    expect(detail.sellable).toBe(70);
    expect(detail.product.quantity).toBe(100);
    expect(detail.leading?.lotNumber).toBe('LOT-OLD');
    expect(detail.leadingDaysToExpiry).toBe(-5);
  });

  it('reports an undated leading lot with a null day count', async () => {
    listBatchesForProductMock.mockResolvedValue([batch({ expiryDate: null })]);

    const detail = await service.getProduct(PHARMACY, PRODUCT, TODAY);

    expect(detail.leading).not.toBeNull();
    expect(detail.leadingDaysToExpiry).toBeNull();
    // Undated stock is always sellable, so it counts towards the figure the till
    // sells against.
    expect(detail.sellable).toBe(100);
  });

  it('reports no leading lot and nothing sellable for an empty product', async () => {
    listBatchesForProductMock.mockResolvedValue([batch({ quantity: 0 })]);

    const detail = await service.getProduct(PHARMACY, PRODUCT, TODAY);

    expect(detail.leading).toBeNull();
    expect(detail.leadingDaysToExpiry).toBeNull();
    expect(detail.sellable).toBe(0);
  });

  it('counts a lot expiring today as sellable', async () => {
    listBatchesForProductMock.mockResolvedValue([batch({ expiryDate: TODAY, quantity: 12 })]);

    const detail = await service.getProduct(PHARMACY, PRODUCT, TODAY);

    // Sellable ON the expiry date, not after. The boundary is the whole rule.
    expect(detail.sellable).toBe(12);
    expect(detail.leadingDaysToExpiry).toBe(0);
  });

  it('answers 404 for a product that is not there, without listing batches', async () => {
    findProductByIdMock.mockResolvedValue(null);

    await expectHttpError(service.getProduct(PHARMACY, PRODUCT, TODAY), 404, 'not_found');
    expect(listBatchesForProductMock).not.toHaveBeenCalled();
  });

  it('reads on the pool, because a read changes nothing', async () => {
    await service.getProduct(PHARMACY, PRODUCT, TODAY);

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(findProductByIdMock).toHaveBeenCalledWith(poolSql, PHARMACY, PRODUCT);
    expect(listBatchesForProductMock).toHaveBeenCalledWith(poolSql, PHARMACY, PRODUCT);
  });
});

describe('listMovements', () => {
  it('checks the product exists first, so an id from nowhere is a 404 and not an empty list', async () => {
    findProductByIdMock.mockResolvedValue(null);

    await expectHttpError(service.listMovements(PHARMACY, PRODUCT, 50), 404, 'not_found');
    expect(queryMovementsMock).not.toHaveBeenCalled();
  });

  it('returns the ledger for a product that exists', async () => {
    queryMovementsMock.mockResolvedValue([movement(), movement({ movementType: 'adjust' })]);

    const rows = await service.listMovements(PHARMACY, PRODUCT, 25);

    expect(rows).toHaveLength(2);
    expect(queryMovementsMock).toHaveBeenCalledWith(poolSql, PHARMACY, PRODUCT, 25);
  });
});

describe('listProducts', () => {
  it('passes the filters through unchanged', async () => {
    const filters = { search: 'para', category: 'Analgesic', limit: 20, offset: 40 };

    await service.listProducts(PHARMACY, filters);

    expect(queryProductsMock).toHaveBeenCalledWith(poolSql, PHARMACY, filters);
  });
});
