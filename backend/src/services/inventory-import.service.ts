import { withSavepoint, withTransaction } from '../database/pool';
import {
  createProduct,
  findProductByCode,
  insertBatch,
  insertMovement,
} from '../repositories/inventory.repository';
import { scoped } from '../utils/logger';
import { findMissingColumns, findUnknownColumns, parseCsv } from '../utils/csv';
import {
  COST_PRICE,
  toBoolean,
  toDateOnlyOrNull,
  toEnumMember,
  toInteger,
  toMoneyString,
  toText,
  toTextOrNull,
  UNIT_PRICE,
} from '../utils/coerce';
import { HttpError } from '../utils/http';
import { SELL_UNITS, VAT_TREATMENTS } from '../utils/schema-enums';
import { resolveReceivedAt, PRODUCT_LIMITS, type Actor } from './inventory.service';

const log = scoped('inventory-import');

/**
 * Bulk product upload from a CSV file, with an opening batch per row.
 *
 * The file is the pharmacy's own spreadsheet, so it is treated as data and not
 * as a script: the header decides which column is which, an unrecognised column
 * is refused outright rather than ignored, and no cell reaches a statement as
 * anything but a parameter.
 *
 * Rows are imported inside one transaction with a savepoint each. That is the
 * only way to get the behaviour the counter needs — four hundred good rows land
 * and the two bad ones come back with their line numbers. A plain try/catch
 * cannot do it: once a statement errors the transaction is aborted and every
 * later statement fails with "current transaction is aborted", so without
 * savepoints one bad row costs the whole file.
 */

/**
 * The columns a template may carry, mapped to the field names the builders use.
 *
 * Snake case here and camel case inside the service, with the translation in one
 * table. The alternative — a builder that reads either spelling — would leave
 * every field with two names and no single place that says which the API uses.
 *
 * `quantity`, `expiry_date` and `cost_price` describe the **opening batch**, not
 * the product. Those three names are also the product's derived columns, and the
 * collision is deliberate and safe: the values land on `inventory_batches` and
 * the product's copies are recomputed from them by the trigger, exactly as they
 * are for a receive. Nothing in this file writes a derived column.
 */
export const IMPORT_COLUMNS = {
  name: 'name',
  code: 'code',
  generic_name: 'genericName',
  category: 'category',
  manufacturer: 'manufacturer',
  pack_size: 'packSize',
  default_sell_unit: 'defaultSellUnit',
  shelf_location: 'shelfLocation',
  barcode: 'barcode',
  requires_prescription: 'requiresPrescription',
  reorder_level: 'reorderLevel',
  unit_price: 'unitPrice',
  vat_treatment: 'vatTreatment',
  lot_number: 'lotNumber',
  expiry_date: 'expiryDate',
  quantity: 'quantity',
  cost_price: 'costPrice',
  received_at: 'receivedAt',
} as const;

export const KNOWN_IMPORT_COLUMNS: readonly string[] = Object.keys(IMPORT_COLUMNS);

/** A row with no name, no code and no price is not a product. */
export const REQUIRED_IMPORT_COLUMNS: readonly string[] = ['name', 'code', 'unit_price'];

/** Rows are refused past this, because a 2mb body of one-column rows is not stock. */
export const MAX_IMPORT_ROWS = 2_000;

export interface ImportRowSuccess {
  /** The line in the file, 1-based, counting the header. */
  line: number;
  code: string;
  productId: string;
  /** Null when the row carried no opening batch. */
  batchId: string | null;
  lotNumber: string | null;
  quantity: number;
}

export interface ImportRowFailure {
  line: number;
  /** The product code when the row got far enough to have one. */
  code: string | null;
  /** A machine-readable label, when there is one worth acting on. */
  errorCode: string | null;
  /** Written for the person who has to fix the spreadsheet. */
  error: string;
}

export interface ImportResult {
  rowsInFile: number;
  imported: ImportRowSuccess[];
  failed: ImportRowFailure[];
  /** True when some rows landed and some did not. */
  partial: boolean;
}

/**
 * What a row failure may say.
 *
 * A database error carries constraint names, column types and sometimes the
 * offending value. None of that belongs in a response, and the person fixing the
 * spreadsheet cannot act on any of it. Known cases get a sentence; everything
 * else gets the same sentence and the real error goes to the log, where it can
 * be read by somebody who can do something about it.
 */
function describeRowError(error: unknown, code: string | null): ImportRowFailure['error'] {
  if (error instanceof HttpError) return error.message;

  const pgCode = (error as { code?: string } | null)?.code;
  if (pgCode === '23505') {
    return 'A product with that code already exists';
  }
  if (pgCode === '23514') {
    return 'A value in that row is outside the range the field allows';
  }
  log.error('csv row failed with an unmapped error', {
    code,
    error: error instanceof Error ? error.message : String(error),
  });
  return 'That row could not be imported. Check the values and try again.';
}

function errorCodeOf(error: unknown): string | null {
  if (error instanceof HttpError) return error.code ?? null;
  const pgCode = (error as { code?: string } | null)?.code;
  if (pgCode === '23505') return 'product_code_taken';
  if (pgCode === '23514') return 'value_out_of_range';
  return null;
}

function fileRejected(message: string, code: string): never {
  throw new HttpError(400, message, { code });
}

/**
 * A blank cell, read as absent.
 *
 * `parseCsv` fills in every name the header carries, so a column that is present
 * in the file and empty in the row arrives as `''` rather than as nothing at
 * all. That difference is invisible to a reader and fatal to `?? default`, which
 * fires only for `null` and `undefined`: `field('pack_size') ?? 1` handed
 * `toInteger` an empty string, and every row of a file carrying that column
 * failed with "Enter the pack size as a whole number".
 *
 * The template the app offers for download carries all eighteen columns, so
 * without this the file a pharmacist fills in and sends back cannot import a
 * single row — not because of anything they typed, but because of the columns
 * they left empty.
 */
function blankAsAbsent(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * One row, translated into the field names the builders expect.
 *
 * Values arrive as strings from a spreadsheet, and the coercers are what turn
 * "10" into 10, "yes" into true and "12.50" into the decimal string Postgres
 * stores. Each one throws an `HttpError` naming the field in the words the
 * template uses, so the failure that reaches the caller says which cell to fix.
 */
function buildRow(
  values: Record<string, string>,
  actor: Actor
): {
  product: Parameters<typeof createProduct>[1];
  batch: null | {
    lotNumber: string;
    quantity: number;
    costPrice: string;
    expiryDate: string | null;
    receivedAt: string;
  };
} {
  // Read by the header name, because that is what `parseCsv` keys the row by.
  // `IMPORT_COLUMNS[csvColumn]` is the *field* name the column becomes, and
  // looking that up in `values` translates the header twice — so every column
  // whose two spellings differ (`unit_price`, `lot_number`, `expiry_date` and
  // nine more) read as absent. `unit_price` is required, which made that a row
  // that could never import rather than a field that was quietly dropped. The
  // map's values say what the builders receive; they are not a key into the row.
  //
  // Blank is folded into absent here rather than at the dozen call sites,
  // because an empty cell and a column the file does not carry mean the same
  // thing and only the second one reaches a `?? default`.
  const field = (csvColumn: keyof typeof IMPORT_COLUMNS): string | undefined =>
    blankAsAbsent(values[csvColumn]);

  const product = {
    pharmacyId: actor.pharmacyId,
    name: toText(field('name'), 'the product name', PRODUCT_LIMITS.name.max),
    code: toText(field('code'), 'the product code', PRODUCT_LIMITS.code.max),
    genericName: toTextOrNull(
      field('generic_name'),
      'the generic name',
      PRODUCT_LIMITS.genericName.max
    ),
    category: toTextOrNull(field('category'), 'the category', PRODUCT_LIMITS.category.max),
    manufacturer: toTextOrNull(
      field('manufacturer'),
      'the manufacturer',
      PRODUCT_LIMITS.manufacturer.max
    ),
    packSize: toInteger(field('pack_size') ?? 1, 'the pack size', PRODUCT_LIMITS.packSize),
    defaultSellUnit: toEnumMember(
      field('default_sell_unit') ?? 'single',
      SELL_UNITS,
      'the selling unit'
    ),
    shelfLocation: toTextOrNull(
      field('shelf_location'),
      'the shelf location',
      PRODUCT_LIMITS.shelfLocation.max
    ),
    barcode: toTextOrNull(field('barcode'), 'the barcode', PRODUCT_LIMITS.barcode.max),
    requiresPrescription: toBoolean(field('requires_prescription'), 'requires_prescription'),
    reorderLevel: toInteger(
      field('reorder_level') ?? 0,
      'the reorder level',
      PRODUCT_LIMITS.reorderLevel
    ),
    unitPrice: toMoneyString(field('unit_price'), UNIT_PRICE),
    vatTreatment: toEnumMember(
      field('vat_treatment') ?? 'exempt',
      VAT_TREATMENTS,
      'the VAT treatment'
    ),
    isActive: true,
  };

  const lotNumber = toTextOrNull(field('lot_number'), 'the lot number', PRODUCT_LIMITS.lotNumber.max);
  const quantityCell = field('quantity');
  const costCell = field('cost_price');
  const expiryCell = field('expiry_date');

  if (lotNumber === null && quantityCell === undefined && costCell === undefined) {
    return { product, batch: null };
  }

  if (lotNumber === null) {
    throw new HttpError(
      400,
      'That row has stock figures but no lot_number. Give the opening batch a lot number, or leave the stock columns empty.',
      { code: 'lot_number_required' }
    );
  }

  return {
    product,
    batch: {
      lotNumber,
      quantity: toInteger(quantityCell ?? 0, 'the quantity', PRODUCT_LIMITS.quantity),
      costPrice: toMoneyString(costCell ?? 0, COST_PRICE),
      expiryDate: toDateOnlyOrNull(expiryCell, 'the expiry date'),
      // An empty cell is stamped now rather than left to the column default,
      // which would give every row in the file the same transaction timestamp.
      // This does not preserve the file's order, and does not claim to: `nowIso()`
      // is millisecond-precision, so a loop over the rows ties most of them and
      // falls back to the random uuid. Nothing needs the order — a duplicate code
      // is refused, so no product takes two batches from one import, and
      // `received_at` only ever orders batches of the same product. A file that
      // wants a real receiving order says so in the column.
      receivedAt: resolveReceivedAt(field('received_at')),
    },
  };
}

/**
 * Imports a CSV file of products with an opening batch per row.
 *
 * File-level problems — no header, an unknown column, a missing required
 * column, no rows — are refused before anything is written, because none of the
 * rows can be trusted when the file's shape is wrong. Row-level problems are
 * collected and returned: the file was understood, and one bad line is not a
 * reason to throw away four hundred good ones.
 */
export async function importProductsCsv(
  actor: Actor,
  source: string
): Promise<ImportResult> {
  let table;
  try {
    table = parseCsv(source);
  } catch (error) {
    // `parseCsv` throws for a file that cannot be trusted at all: no header, a
    // duplicate or empty header name, an unterminated quote. Those are 400s,
    // and the message is written for a person holding a spreadsheet.
    fileRejected(
      error instanceof Error ? error.message : 'That file could not be read',
      'csv_malformed'
    );
  }

  const unknown = findUnknownColumns(table.header, KNOWN_IMPORT_COLUMNS);
  if (unknown.length > 0) {
    fileRejected(
      `The file has column${unknown.length === 1 ? '' : 's'} this import does not use: ` +
        `${unknown.join(', ')}. Remove ${unknown.length === 1 ? 'it' : 'them'} and try again.`,
      'csv_unknown_columns'
    );
  }

  const missing = findMissingColumns(table.header, REQUIRED_IMPORT_COLUMNS);
  if (missing.length > 0) {
    fileRejected(
      `The file is missing the column${missing.length === 1 ? '' : 's'} every product needs: ` +
        `${missing.join(', ')}.`,
      'csv_missing_columns'
    );
  }

  if (table.rows.length === 0) {
    fileRejected('The file has a header but no products in it', 'csv_empty');
  }
  if (table.rows.length > MAX_IMPORT_ROWS) {
    fileRejected(
      `That file has ${table.rows.length} rows; the most this import takes at once is ${MAX_IMPORT_ROWS}.`,
      'csv_too_many_rows'
    );
  }

  const imported: ImportRowSuccess[] = [];
  const failed: ImportRowFailure[] = [];

  await withTransaction(async (client) => {
    for (const row of table.rows) {
      if (!row.ok) {
        // A row the parser could not split — almost always a comma inside a
        // value that was not wrapped in quotes. The parser already says so.
        failed.push({
          line: row.line,
          code: null,
          errorCode: 'csv_row_malformed',
          error: row.error,
        });
        continue;
      }

      const codeCell = blankAsAbsent(row.values.code) ?? null;
      try {
        // The savepoint name is built from the line number, and `withSavepoint`
        // validates it against a pattern that admits no punctuation. Nothing
        // from the file reaches it.
        await withSavepoint(client, `csv_row_${row.line}`, async () => {
          const { product, batch } = buildRow(row.values, actor);

          const existing = await findProductByCode(client, actor.pharmacyId, product.code);
          if (existing !== null) {
            throw new HttpError(
              409,
              `A product with code ${product.code} already exists, so this row was skipped`,
              { code: 'product_code_taken' }
            );
          }

          const created = await createProduct(client, product);

          let batchId: string | null = null;
          let lotNumber: string | null = null;
          let quantity = 0;

          if (batch !== null) {
            const inserted = await insertBatch(client, {
              pharmacyId: actor.pharmacyId,
              inventoryId: created.id,
              lotNumber: batch.lotNumber,
              expiryDate: batch.expiryDate,
              quantity: batch.quantity,
              costPrice: batch.costPrice,
              receivedAt: batch.receivedAt,
            });
            await insertMovement(client, {
              pharmacyId: actor.pharmacyId,
              inventoryId: created.id,
              batchId: inserted.id,
              saleId: null,
              // 'opening', not 'receive': this stock was already on the shelf
              // when the system arrived, and the difference matters when
              // somebody asks what was bought and when.
              movementType: 'opening',
              quantityChange: batch.quantity,
              quantityAfter: inserted.quantity,
              reason: 'Opening stock imported from CSV',
              note: `Line ${row.line}`,
              performedBy: actor.userId,
            });
            batchId = inserted.id;
            lotNumber = inserted.lotNumber;
            quantity = inserted.quantity;
          }

          imported.push({
            line: row.line,
            code: product.code,
            productId: created.id,
            batchId,
            lotNumber,
            quantity,
          });
        });
      } catch (error) {
        failed.push({
          line: row.line,
          code: codeCell,
          errorCode: errorCodeOf(error),
          error: describeRowError(error, codeCell),
        });
      }
    }
  });

  return {
    rowsInFile: table.rows.length,
    imported,
    failed,
    partial: imported.length > 0 && failed.length > 0,
  };
}

/** The header line of a blank template, so the frontend can offer a download. */
export function importTemplate(): string {
  return KNOWN_IMPORT_COLUMNS.join(',') + '\n';
}
