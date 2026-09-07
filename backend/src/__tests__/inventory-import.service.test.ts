jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
  withSavepoint: jest.fn(),
}));

jest.mock('../repositories/inventory.repository', () => ({
  createProduct: jest.fn(),
  findBatch: jest.fn(),
  findBatchByLot: jest.fn(),
  findProductByCode: jest.fn(),
  findProductById: jest.fn(),
  insertBatch: jest.fn(),
  insertMovement: jest.fn(),
  listActiveProducts: jest.fn(),
  listBatchesForProduct: jest.fn(),
  listBatchesHoldingStock: jest.fn(),
  listMovements: jest.fn(),
  listProducts: jest.fn(),
  lockProduct: jest.fn(),
  mergeIntoBatch: jest.fn(),
  recallTrace: jest.fn(),
  setBatchQuantity: jest.fn(),
  updateProduct: jest.fn(),
}));

// One shared sink object, reachable through the mocked module's `logger` export.
// `scoped()` is called once when the service loads, so a factory that built a new
// object per call would leave the assertions nothing to hold.
jest.mock('../utils/logger', () => {
  const sinks = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  return { scoped: () => sinks, logger: sinks };
});

import type { PoolClient } from 'pg';
import { withSavepoint, withTransaction } from '../database/pool';
import {
  createProduct,
  findProductByCode,
  insertBatch,
  insertMovement,
  type NewMovement,
  type ProductRow,
} from '../repositories/inventory.repository';
import { logger } from '../utils/logger';
import {
  IMPORT_COLUMNS,
  KNOWN_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  REQUIRED_IMPORT_COLUMNS,
  importProductsCsv,
  importTemplate,
} from '../services/inventory-import.service';
import { PRODUCT_LIMITS, type Actor } from '../services/inventory.service';

/**
 * The CSV bulk import.
 *
 * The repositories, the pool and the logger are mocked. `utils/csv` and
 * `utils/coerce` are not: they are the parser and the coercion rules this service
 * is built out of, and stubbing them would replace the thing under test with a
 * fiction. `utils/csv` has its own suite for its own edges; what is asserted here
 * is what the importer decides.
 *
 * The shape of the guarantee is the reason the suite is organised this way. Two
 * kinds of failure are handled completely differently, and confusing them is the
 * bug:
 *
 * - A **file-level** problem — no header, an unknown column, a missing required
 *   column, too many rows — is refused before a single savepoint is opened,
 *   because none of the rows can be trusted when the file's shape is wrong.
 * - A **row-level** problem is collected and returned, so four hundred good rows
 *   land and the two bad ones come back with their line numbers.
 *
 * Every file-level test therefore asserts that no transaction was opened, and
 * every row-level test asserts that the rows around the failure still landed.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a0000000-0000-4000-8000-000000000002';
const ACTOR: Actor = { userId: USER, pharmacyId: PHARMACY };

const CLIENT = { query: jest.fn() } as unknown as PoolClient;

const FUTURE = '2027-01-31';

const withTransactionMock = jest.mocked(withTransaction);
const withSavepointMock = jest.mocked(withSavepoint);
const createProductMock = jest.mocked(createProduct);
const findProductByCodeMock = jest.mocked(findProductByCode);
const insertBatchMock = jest.mocked(insertBatch);
const insertMovementMock = jest.mocked(insertMovement);

const logError = (logger as unknown as { error: jest.Mock }).error;

/** The three columns every product needs, and nothing else. */
const MIN_HEADER = [...REQUIRED_IMPORT_COLUMNS];

/** The columns the downloaded template carries. */
const TEMPLATE_HEADER = [...KNOWN_IMPORT_COLUMNS];

function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 'a0000000-0000-4000-8000-000000000010',
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
    unitPrice: '12.50',
    vatTreatment: 'exempt',
    isActive: true,
    quantity: 0,
    batchNumber: null,
    expiryDate: null,
    costPrice: '0.0000',
    createdAt: '2026-03-15T09:00:00.000Z',
    updatedAt: '2026-03-15T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * Builds a CSV file. A null cell is written empty, as a spreadsheet writes it.
 *
 * A cell carrying a comma, a quote or a newline is wrapped, because the whole
 * point of those cells in a test is that they are ordinary data. Joining on
 * commas without quoting writes a row with more fields than the header, and the
 * parser then refuses it for a reason nobody intended — the test looks like it
 * is proving "punctuation survives the import" while actually proving "a
 * malformed row is rejected", and passes or fails on the wrong thing.
 */
function csv(header: readonly string[], rows: readonly (readonly (string | null)[])[]): string {
  const cell = (value: string | null): string => {
    const text = value ?? '';
    return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
  };
  const line = (cells: readonly (string | null)[]): string => cells.map(cell).join(',');
  return [line(header), ...rows.map(line)].join('\n') + '\n';
}

/**
 * A row of the downloaded template, filled in by column name.
 *
 * Positional rows are a trap against an eighteen-column header: the third
 * position is `generic_name`, not `unit_price`, so a test that means "one
 * minimal product" quietly writes a file with no price in it and then asserts
 * something about a validation error it caused itself.
 */
function templateRow(cells: Record<string, string>): string[] {
  return TEMPLATE_HEADER.map((name) => cells[name] ?? '');
}

/** The savepoint names the importer asked for, in order. */
function savepointNames(): string[] {
  return withSavepointMock.mock.calls.map((call) => call[1]);
}

/** The last `NewMovement` handed to the ledger. */
function lastMovement(): NewMovement | undefined {
  return insertMovementMock.mock.calls.at(-1)?.[1];
}

/** A Postgres error, which is a plain Error with a SQLSTATE on it. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  withTransactionMock.mockImplementation(async (work) => work(CLIENT));
  // A savepoint runs its work and, on success, is indistinguishable from no
  // savepoint at all. What it does on failure — undo this row's writes and leave
  // the transaction usable — is real-Postgres behaviour and belongs to the
  // harness, not to a mock.
  withSavepointMock.mockImplementation(async (_client, _name, work) => work());

  let created = 0;
  createProductMock.mockImplementation(async (_sql, input) => {
    created += 1;
    return product({
      id: `a0000000-0000-4000-8000-0000000000f${String(created)}`,
      name: input.name,
      code: input.code,
    });
  });
  findProductByCodeMock.mockResolvedValue(null);
  insertBatchMock.mockImplementation(async (_sql, input) => ({
    id: 'a0000000-0000-4000-8000-0000000000b1',
    pharmacyId: input.pharmacyId,
    inventoryId: input.inventoryId,
    lotNumber: input.lotNumber,
    expiryDate: input.expiryDate,
    quantity: input.quantity,
    costPrice: input.costPrice,
    receivedAt: input.receivedAt,
    createdAt: '2026-03-15T09:00:00.000Z',
    updatedAt: '2026-03-15T09:00:00.000Z',
  }));
  insertMovementMock.mockResolvedValue(undefined);
});

describe('the columns it accepts', () => {
  it('offers a template whose header is exactly the columns it accepts', () => {
    expect(importTemplate()).toBe(TEMPLATE_HEADER.join(',') + '\n');
  });

  it('accepts a file built from its own template', async () => {
    const result = await importProductsCsv(
      ACTOR,
      csv(TEMPLATE_HEADER, [
        templateRow({ name: 'Paracetamol 500mg', code: 'PARA-500', unit_price: '12.50' }),
      ])
    );

    // The template and the importer cannot be allowed to drift: a file the
    // pharmacy downloads and fills in must import, or the download is a trap.
    expect(result.failed).toEqual([]);
    expect(result.imported).toHaveLength(1);
  });

  it('maps every known column to a distinct field name', () => {
    expect(Object.keys(IMPORT_COLUMNS)).toEqual(TEMPLATE_HEADER);

    const fields = Object.values(IMPORT_COLUMNS);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('requires only columns it actually knows', () => {
    for (const required of REQUIRED_IMPORT_COLUMNS) {
      expect(KNOWN_IMPORT_COLUMNS).toContain(required);
    }
  });

  it('translates the snake_case header into the camelCase names the builders use', () => {
    expect(IMPORT_COLUMNS.generic_name).toBe('genericName');
    expect(IMPORT_COLUMNS.default_sell_unit).toBe('defaultSellUnit');
    expect(IMPORT_COLUMNS.requires_prescription).toBe('requiresPrescription');
    expect(IMPORT_COLUMNS.vat_treatment).toBe('vatTreatment');
    expect(IMPORT_COLUMNS.lot_number).toBe('lotNumber');
    expect(IMPORT_COLUMNS.expiry_date).toBe('expiryDate');
    expect(IMPORT_COLUMNS.cost_price).toBe('costPrice');
    expect(IMPORT_COLUMNS.received_at).toBe('receivedAt');
  });

  it('reads a column by its header name, so column order in the file does not matter', async () => {
    await importProductsCsv(
      ACTOR,
      csv(['unit_price', 'name', 'code'], [['12.50', 'Paracetamol 500mg', 'PARA-500']])
    );

    expect(createProductMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ name: 'Paracetamol 500mg', code: 'PARA-500', unitPrice: '12.50' })
    );
  });
});

describe('a file it refuses outright', () => {
  async function refused(source: string, code: string): Promise<void> {
    const thrown = await importProductsCsv(ACTOR, source).then(
      () => null,
      (error: unknown) => error
    );
    expect(thrown).not.toBeNull();
    expect((thrown as { code?: string }).code).toBe(code);
    expect((thrown as { status?: number }).status).toBe(400);
    // Refused before anything is written: no transaction, no savepoint, no row.
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(withSavepointMock).not.toHaveBeenCalled();
    expect(createProductMock).not.toHaveBeenCalled();
  }

  it('refuses a file with no header', async () => {
    await refused('', 'csv_malformed');
  });

  it('refuses a header that names a column twice', async () => {
    await refused(csv(['name', 'code', 'unit_price', 'code'], []), 'csv_malformed');
  });

  it('refuses an unterminated quote, because the rest of the file is unreadable', async () => {
    await refused('name,code,unit_price\n"Paracetamol,PARA-500,12.50\n', 'csv_malformed');
  });

  it('refuses a column it does not use, and names it', async () => {
    const source = csv(['name', 'code', 'unit_price', 'expirty_date'], [
      ['Paracetamol 500mg', 'PARA-500', '12.50', FUTURE],
    ]);

    const thrown = await importProductsCsv(ACTOR, source).then(
      () => null,
      (error: unknown) => error as { message: string }
    );

    // A header typo would otherwise import every row with no expiry at all and
    // report success, and the pharmacy would find out when stock started
    // disappearing without ever having been dated.
    expect(thrown?.message).toContain('expirty_date');
    expect(thrown?.message).toContain('does not use');
    await refused(source, 'csv_unknown_columns');
  });

  it('names every unknown column and pluralises', async () => {
    const thrown = await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'colour', 'weight'], [['A', 'A-1', '1.00', 'red', '2']])
    ).then(
      () => null,
      (error: unknown) => error as { message: string }
    );

    expect(thrown?.message).toContain('columns');
    expect(thrown?.message).toContain('colour');
    expect(thrown?.message).toContain('weight');
    expect(thrown?.message).toContain('them');
  });

  it('refuses a file missing a required column, and names it', async () => {
    const thrown = await importProductsCsv(ACTOR, csv(['name', 'code'], [['A', 'A-1']])).then(
      () => null,
      (error: unknown) => error as { message: string; code?: string }
    );

    expect(thrown?.code).toBe('csv_missing_columns');
    expect(thrown?.message).toContain('unit_price');
  });

  it('names all three when the file has none of them', async () => {
    const thrown = await importProductsCsv(ACTOR, csv(['category'], [['Analgesic']])).then(
      () => null,
      (error: unknown) => error as { message: string }
    );

    for (const required of REQUIRED_IMPORT_COLUMNS) {
      expect(thrown?.message).toContain(required);
    }
  });

  it('refuses a header with no rows in it', async () => {
    await refused(csv(MIN_HEADER, []), 'csv_empty');
  });

  it('refuses a file past the row limit, quoting both numbers', async () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_unused, index) => [
      `Product ${String(index)}`,
      `C-${String(index)}`,
      '1.00',
    ]);

    const thrown = await importProductsCsv(ACTOR, csv(MIN_HEADER, rows)).then(
      () => null,
      (error: unknown) => error as { message: string; code?: string }
    );

    expect(thrown?.code).toBe('csv_too_many_rows');
    expect(thrown?.message).toContain(String(MAX_IMPORT_ROWS + 1));
    expect(thrown?.message).toContain(String(MAX_IMPORT_ROWS));
    expect(createProductMock).not.toHaveBeenCalled();
  });

  it('accepts a file of exactly the row limit', async () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_unused, index) => [
      `Product ${String(index)}`,
      `C-${String(index)}`,
      '1.00',
    ]);

    const result = await importProductsCsv(ACTOR, csv(MIN_HEADER, rows));

    // The limit is `>`, not `>=`: the row it names is the row it accepts.
    expect(result.rowsInFile).toBe(MAX_IMPORT_ROWS);
    expect(result.imported).toHaveLength(MAX_IMPORT_ROWS);
    expect(result.failed).toEqual([]);
  });
});

describe('a row it imports', () => {
  it('creates a product and no batch when the row carries no stock', async () => {
    const result = await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [['Paracetamol 500mg', 'PARA-500', '12.50']])
    );

    expect(result.imported).toEqual([
      {
        line: 2,
        code: 'PARA-500',
        productId: expect.any(String),
        batchId: null,
        lotNumber: null,
        quantity: 0,
      },
    ]);
    expect(insertBatchMock).not.toHaveBeenCalled();
    expect(insertMovementMock).not.toHaveBeenCalled();
  });

  it('creates a product and an opening batch when the row carries stock', async () => {
    const result = await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'lot_number', 'quantity', 'cost_price', 'expiry_date'], [
        ['Paracetamol 500mg', 'PARA-500', '12.50', 'LOT-1', '40', '8.25', FUTURE],
      ])
    );

    expect(result.imported).toEqual([
      {
        line: 2,
        code: 'PARA-500',
        productId: expect.any(String),
        batchId: 'a0000000-0000-4000-8000-0000000000b1',
        lotNumber: 'LOT-1',
        quantity: 40,
      },
    ]);
    expect(insertBatchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        pharmacyId: PHARMACY,
        lotNumber: 'LOT-1',
        quantity: 40,
        costPrice: '8.25',
        expiryDate: FUTURE,
      })
    );
  });

  it('records the opening batch as an opening, not as a receive', async () => {
    await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'lot_number', 'quantity'], [
        ['Paracetamol 500mg', 'PARA-500', '12.50', 'LOT-1', '40'],
      ])
    );

    // This stock was already on the shelf when the system arrived. Recording it
    // as a receive would put a purchase in the ledger that never happened, and
    // the difference matters when somebody asks what was bought and when.
    expect(lastMovement()).toEqual(
      expect.objectContaining({
        movementType: 'opening',
        quantityChange: 40,
        quantityAfter: 40,
        saleId: null,
        performedBy: USER,
      })
    );
    expect(lastMovement()?.movementType).not.toBe('receive');
  });

  it('writes a reason and a note naming the line the stock came from', async () => {
    await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'lot_number', 'quantity'], [
        ['A', 'A-1', '1.00', 'LOT-1', '5'],
        ['B', 'B-1', '1.00', 'LOT-2', '7'],
      ])
    );

    const notes = insertMovementMock.mock.calls.map((call) => call[1].note);
    expect(notes).toEqual(['Line 2', 'Line 3']);
    for (const call of insertMovementMock.mock.calls) {
      expect(call[1].reason).toBe('Opening stock imported from CSV');
    }
  });

  it('applies the product defaults to a row that omits the optional columns', async () => {
    await importProductsCsv(ACTOR, csv(MIN_HEADER, [['Paracetamol 500mg', 'PARA-500', '12.50']]));

    expect(createProductMock.mock.calls[0]?.[1]).toEqual({
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
      unitPrice: '12.50',
      vatTreatment: 'exempt',
      isActive: true,
    });
  });

  it('reads the spreadsheet spellings of a boolean', async () => {
    await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'requires_prescription'], [
        ['Amoxicillin', 'AMOX-1', '9.00', 'yes'],
        ['Paracetamol', 'PARA-1', '9.00', 'no'],
        ['Ibuprofen', 'IBU-1', '9.00', ''],
      ])
    );

    const flags = createProductMock.mock.calls.map((call) => call[1].requiresPrescription);
    // A blank cell is "not a prescription item", which is also the column's
    // default. Refusing it would fail every row of a template that carries the
    // column and leaves it mostly empty.
    expect(flags).toEqual([true, false, false]);
  });

  it('keeps money as the decimal string it arrived as', async () => {
    await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'lot_number', 'quantity', 'cost_price'], [
        ['A', 'A-1', '12.50', 'LOT-1', '5', '8.2500'],
      ])
    );

    expect(createProductMock.mock.calls[0]?.[1].unitPrice).toBe('12.50');
    expect(insertBatchMock.mock.calls[0]?.[1].costPrice).toBe('8.2500');
  });

  it('imports a row from the downloaded template with the stock columns left blank', async () => {
    // The template carries every column, so this is the file a pharmacist
    // actually produces: a few cells filled in, the rest left empty. An empty
    // cell arrives as '' rather than as nothing at all, and '' defeats every
    // `?? default` in the row builder — so this row used to die on "Enter the
    // pack size as a whole number" long before it reached the stock columns.
    const row = templateRow({
      name: 'Paracetamol 500mg',
      code: 'PARA-500',
      unit_price: '12.50',
      pack_size: '10',
      requires_prescription: 'no',
    });

    const result = await importProductsCsv(ACTOR, csv(TEMPLATE_HEADER, [row]));

    expect(result.failed).toEqual([]);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.batchId).toBeNull();
    expect(insertBatchMock).not.toHaveBeenCalled();
    // The four columns whose default is written `?? value` at the call site, so
    // the four that a blank cell used to bypass. `pack_size` is filled in here
    // to prove the folding goes one way only: blank takes the default, a value
    // does not. `requiresPrescription` is not one of the four — `toBoolean`
    // handles its own blank — but it is asserted because it reads the same way.
    expect(createProductMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        packSize: 10,
        defaultSellUnit: 'single',
        vatTreatment: 'exempt',
        reorderLevel: 0,
        requiresPrescription: false,
      })
    );
  });
});

describe('a row it refuses without refusing the file', () => {
  it('refuses stock figures with no lot number, and names the row', async () => {
    const result = await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'quantity'], [
        ['A', 'A-1', '1.00', '40'],
        ['B', 'B-1', '1.00', null],
      ])
    );

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.code).toBe('B-1');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual(
      expect.objectContaining({ line: 2, code: 'A-1', errorCode: 'lot_number_required' })
    );
    expect(result.failed[0]?.error).toContain('lot_number');
    expect(result.partial).toBe(true);
  });

  it('refuses a second row with the code a product already holds', async () => {
    findProductByCodeMock.mockImplementation(async (_sql, _pharmacyId, code) =>
      code === 'PARA-500' ? product({ code }) : null
    );

    const result = await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [
        ['Paracetamol 500mg', 'PARA-500', '12.50'],
        ['Ibuprofen 400mg', 'IBU-400', '9.00'],
      ])
    );

    expect(result.failed).toEqual([
      expect.objectContaining({ line: 2, code: 'PARA-500', errorCode: 'product_code_taken' }),
    ]);
    expect(result.failed[0]?.error).toContain('PARA-500');
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.code).toBe('IBU-400');
    // The refused row never reached the insert, so there is nothing to roll back.
    expect(createProductMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a row whose received date is in the future, and imports the rest', async () => {
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const result = await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'lot_number', 'quantity', 'received_at'], [
        ['A', 'A-1', '1.00', 'LOT-1', '5', nextWeek],
        ['B', 'B-1', '1.00', 'LOT-2', '5', null],
      ])
    );

    // The same rule the JSON receive applies, from the same function: two copies
    // would be two chances to get the FEFO tie-break wrong in one of them.
    expect(result.failed[0]?.errorCode).toBe('received_at_in_future');
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.code).toBe('B-1');
  });

  it('refuses an expiry date that is not a real calendar date', async () => {
    const result = await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'lot_number', 'quantity', 'expiry_date'], [
        ['A', 'A-1', '1.00', 'LOT-1', '5', '2026-02-30'],
      ])
    );

    // 30 February is what a typo looks like, and a pattern match alone would
    // accept it and roll it forward to 2 March.
    expect(result.imported).toEqual([]);
    expect(result.failed[0]?.error).toContain('YYYY-MM-DD');
    expect(insertBatchMock).not.toHaveBeenCalled();
  });

  it('refuses a price with more decimal places than the column holds', async () => {
    const result = await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [['A', 'A-1', '12.345']])
    );

    // Checked here rather than left to Postgres, which would round it to 12.35
    // in a numeric(12, 2) column without saying so.
    expect(result.failed[0]?.error).toContain('decimal places');
    expect(createProductMock).not.toHaveBeenCalled();
  });

  it('reports a row the parser could not split, and carries on', async () => {
    const result = await importProductsCsv(
      ACTOR,
      'name,code,unit_price\nParacetamol 500mg, tabs,PARA-500,12.50\nIbuprofen,IBU-1,9.00\n'
    );

    expect(result.failed).toEqual([
      expect.objectContaining({ line: 2, code: null, errorCode: 'csv_row_malformed' }),
    ]);
    // The message is the parser's, and it says what to do about it.
    expect(result.failed[0]?.error).toContain('double quotes');
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.code).toBe('IBU-1');
    expect(result.partial).toBe(true);
  });

  it('counts a row it could not read in rowsInFile', async () => {
    const result = await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [
        ['A', 'A-1', '1.00'],
        ['B', 'B-1', 'not a price'],
        ['C', 'C-1', '3.00'],
      ])
    );

    // rowsInFile describes the file, not the outcome, so the numbers have to add
    // up: somebody reading the report can see nothing was dropped.
    expect(result.rowsInFile).toBe(3);
    expect(result.imported).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.imported.length + result.failed.length).toBe(result.rowsInFile);
  });
});

describe('what a row failure is allowed to say', () => {
  it('translates a unique violation into a sentence, not a constraint name', async () => {
    // The pre-check above makes this rare, but two imports running at once can
    // both pass it, so the mapping is still load-bearing.
    createProductMock.mockRejectedValue(
      pgError('23505', 'duplicate key value violates unique constraint "inventory_code_key"')
    );

    const result = await importProductsCsv(ACTOR, csv(MIN_HEADER, [['A', 'A-1', '1.00']]));

    expect(result.failed[0]).toEqual(
      expect.objectContaining({
        errorCode: 'product_code_taken',
        error: 'A product with that code already exists',
      })
    );
  });

  it('translates a check violation into a sentence about the range', async () => {
    createProductMock.mockRejectedValue(
      pgError('23514', 'new row for relation "inventory" violates check constraint "x"')
    );

    const result = await importProductsCsv(ACTOR, csv(MIN_HEADER, [['A', 'A-1', '1.00']]));

    expect(result.failed[0]).toEqual(
      expect.objectContaining({
        errorCode: 'value_out_of_range',
        error: 'A value in that row is outside the range the field allows',
      })
    );
  });

  it('withholds an unmapped database error and logs it instead', async () => {
    const secret = 'column "pack_size" of relation "inventory" receives a negative value';
    createProductMock.mockRejectedValue(pgError('22023', secret));

    const result = await importProductsCsv(ACTOR, csv(MIN_HEADER, [['A', 'A-1', '1.00']]));

    // A database error carries constraint names, column types and sometimes the
    // offending value. None of that belongs in a response, and the person fixing
    // the spreadsheet cannot act on any of it.
    expect(result.failed[0]?.error).toBe(
      'That row could not be imported. Check the values and try again.'
    );
    expect(result.failed[0]?.error).not.toContain('inventory');
    expect(result.failed[0]?.error).not.toContain('pack_size');
    expect(result.failed[0]?.errorCode).toBeNull();

    // But it is not swallowed: the real message reaches the log, where somebody
    // who can do something about it can read it.
    expect(logError).toHaveBeenCalled();
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain('pack_size');
  });

  it('passes an HttpError message through, because that one was written for the reader', async () => {
    const result = await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'quantity'], [['A', 'A-1', '1.00', '5']])
    );

    expect(result.failed[0]?.error).toContain('lot_number');
    expect(result.failed[0]?.errorCode).toBe('lot_number_required');
  });
});

describe('savepoints', () => {
  it('opens one per row, named from the line number', async () => {
    await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [
        ['A', 'A-1', '1.00'],
        ['B', 'B-1', '1.00'],
        ['C', 'C-1', '1.00'],
      ])
    );

    // Line 1 is the header, so the first row is line 2.
    expect(savepointNames()).toEqual(['csv_row_2', 'csv_row_3', 'csv_row_4']);
    for (const call of withSavepointMock.mock.calls) {
      expect(call[0]).toBe(CLIENT);
    }
  });

  it('builds the name from nothing in the file', async () => {
    await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [
        ["'; DROP TABLE inventory; --", 'A-1', '1.00'],
        ['B", C', 'B-1', '1.00'],
      ])
    );

    // `withSavepoint` interpolates the name into the statement, because Postgres
    // does not accept `SAVEPOINT $1`. That makes this the one place a value
    // reaches SQL as text, so it is worth proving that nothing a spreadsheet
    // contains can get there.
    expect(savepointNames()).toEqual(['csv_row_2', 'csv_row_3']);
    for (const name of savepointNames()) {
      expect(name).toMatch(/^csv_row_\d+$/u);
    }
    // And both rows still imported, the punctuation being ordinary data.
    expect(createProductMock).toHaveBeenCalledTimes(2);
  });

  it('keeps importing after a row fails, which is the whole reason for the savepoint', async () => {
    createProductMock.mockImplementation(async (_sql, input) => {
      if (input.code === 'B-1') throw pgError('23514', 'check constraint');
      return product({ code: input.code, name: input.name });
    });

    const result = await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [
        ['A', 'A-1', '1.00'],
        ['B', 'B-1', '1.00'],
        ['C', 'C-1', '1.00'],
        ['D', 'D-1', '1.00'],
      ])
    );

    // Without a savepoint the transaction would be aborted by the failure and
    // every later row would fail with "current transaction is aborted", so one
    // bad row would cost the whole file.
    expect(result.imported.map((row) => row.code)).toEqual(['A-1', 'C-1', 'D-1']);
    expect(result.failed.map((row) => row.line)).toEqual([3]);
    expect(savepointNames()).toEqual(['csv_row_2', 'csv_row_3', 'csv_row_4', 'csv_row_5']);
  });

  it('runs every row inside one transaction, not one transaction per row', async () => {
    await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [
        ['A', 'A-1', '1.00'],
        ['B', 'B-1', '1.00'],
      ])
    );

    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(withSavepointMock).toHaveBeenCalledTimes(2);
  });
});

describe('the report', () => {
  it('is partial only when some rows landed and some did not', async () => {
    const partial = await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [
        ['A', 'A-1', '1.00'],
        ['B', 'B-1', 'nope'],
      ])
    );
    expect(partial.partial).toBe(true);

    const clean = await importProductsCsv(ACTOR, csv(MIN_HEADER, [['A', 'A-2', '1.00']]));
    expect(clean.partial).toBe(false);

    const hopeless = await importProductsCsv(ACTOR, csv(MIN_HEADER, [['A', 'A-3', 'nope']]));
    expect(hopeless.partial).toBe(false);
    expect(hopeless.imported).toEqual([]);
  });

  it('reports line numbers a person can find in their spreadsheet', async () => {
    const result = await importProductsCsv(
      ACTOR,
      csv(MIN_HEADER, [
        ['A', 'A-1', '1.00'],
        ['B', 'B-1', 'nope'],
        ['C', 'C-1', '1.00'],
        ['D', 'D-1', 'nope'],
      ])
    );

    expect(result.failed.map((row) => row.line)).toEqual([3, 5]);
    expect(result.imported.map((row) => row.line)).toEqual([2, 4]);
  });

  it('carries the product code on a failure whenever the row got far enough to have one', async () => {
    const result = await importProductsCsv(
      ACTOR,
      'name,code,unit_price\nA,A-1,1.00\nBroken,too,many,cells\n'
    );

    // A row the parser could not split has no columns at all, so there is no code
    // to report. Saying null is honest; guessing from the raw text is not.
    expect(result.failed[0]?.code).toBeNull();
  });

  it('never writes a derived product column, even though the file has columns named like them', async () => {
    await importProductsCsv(
      ACTOR,
      csv(['name', 'code', 'unit_price', 'lot_number', 'quantity', 'cost_price', 'expiry_date'], [
        ['A', 'A-1', '12.50', 'LOT-1', '40', '8.25', FUTURE],
      ])
    );

    // `quantity`, `cost_price` and `expiry_date` are also the names of three of
    // the product's four derived columns. The collision is deliberate: those
    // values belong to the opening batch, and the product's copies are recomputed
    // from it by the trigger. What must not happen is the importer writing them
    // onto the product row itself.
    const inserted = createProductMock.mock.calls[0]?.[1];
    expect(inserted).toBeDefined();
    expect(Object.keys(inserted as object)).not.toContain('quantity');
    expect(Object.keys(inserted as object)).not.toContain('costPrice');
    expect(Object.keys(inserted as object)).not.toContain('expiryDate');
    expect(Object.keys(inserted as object)).not.toContain('batchNumber');

    // And the batch insert carries them, because that is where they belong.
    expect(Object.keys(insertBatchMock.mock.calls[0]?.[1] as object)).toEqual(
      expect.arrayContaining(['quantity', 'costPrice', 'expiryDate', 'lotNumber'])
    );
    expect(PRODUCT_LIMITS.quantity.min).toBe(1);
  });
});
