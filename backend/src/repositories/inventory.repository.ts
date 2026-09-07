import type { Sql } from '../database/pool';
import { HttpError } from '../utils/http';
import type { BatchStock } from '../utils/fefo';
import type { MovementType, SaleStatus, SellUnit, VatTreatment } from '../utils/schema-enums';

/**
 * Products, batches and the movement ledger.
 *
 * Two rules shape every statement here.
 *
 * The first is that the four derived product columns — `quantity`,
 * `batch_number`, `expiry_date`, `cost_price` — never appear in an INSERT or an
 * UPDATE column list. They are recomputed by `recompute_inventory_from_batches`
 * from the batches, so writing them is at best ignored and at worst a lie that
 * survives until the next batch changes. `ProductPatch` does not contain them
 * either, which makes it a compile error to try.
 *
 * The second is enum parameters. A parameter assigned to an enum column needs no
 * cast: the column forces the type. A parameter *compared* against one does,
 * because a comparison gives the parser two unknowns to resolve between and it
 * picks text — which is the parse failure that stopped every sale on the
 * previous build. Casts below appear only where they are load-bearing, and each
 * one says so.
 *
 * Every function takes a `Sql` rather than importing the pool. Stock writes are
 * multi-statement and must be atomic, so they run on a transaction client; reads
 * pass `poolSql`. See `database/pool.ts` for why that is a required parameter
 * and not an optional one.
 */

const PRODUCT_COLUMNS = `id, pharmacy_id, name, code, generic_name, category, manufacturer,
  pack_size, default_sell_unit, shelf_location, barcode, requires_prescription,
  reorder_level, unit_price, vat_treatment, is_active, quantity, batch_number,
  expiry_date, cost_price, created_at, updated_at`;

const BATCH_COLUMNS = `id, pharmacy_id, inventory_id, lot_number, expiry_date,
  quantity, cost_price, received_at, created_at, updated_at`;

const MOVEMENT_COLUMNS = `id, pharmacy_id, inventory_id, batch_id, sale_id, movement_type,
  quantity_change, quantity_after, reason, note, performed_by, created_at`;

export interface ProductRow {
  id: string;
  pharmacyId: string;
  name: string;
  code: string;
  genericName: string | null;
  category: string | null;
  manufacturer: string | null;
  packSize: number;
  defaultSellUnit: SellUnit;
  shelfLocation: string | null;
  barcode: string | null;
  requiresPrescription: boolean;
  reorderLevel: number;
  /**
   * Decimal string, as Postgres returns a `numeric`. Never a double.
   *
   * **Per base unit** — per tablet, not per strip. The price of a selling unit is
   * this times `packSize` when the line sells packs, and this unchanged when it
   * sells singles; `sellingUnitPricePesewas` in the shared package owns that
   * conversion and its header carries the reasoning, including why the direction
   * is a multiplication and never a division.
   *
   * Recorded here because this is the field a caller reads and the column itself
   * does not say which of the two units it means. Passing it straight into a basket
   * line for a pack sale charges a tenth of the price; passing it multiplied for a
   * single charges ten times it. Both produce a receipt whose lines add up.
   */
  unitPrice: string;
  vatTreatment: VatTreatment;
  isActive: boolean;
  /** Derived. Total base units on hand, expired stock included. */
  quantity: number;
  /** Derived. Lot at the front of the shelf, whether or not it is still sellable. */
  batchNumber: string | null;
  /** Derived. Expiry of that lot. */
  expiryDate: string | null;
  /** Derived. Quantity-weighted average cost across batches holding stock. */
  costPrice: string;
  createdAt: string;
  updatedAt: string;
}

export interface BatchRow extends BatchStock {
  pharmacyId: string;
  inventoryId: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewProduct {
  pharmacyId: string;
  name: string;
  code: string;
  genericName: string | null;
  category: string | null;
  manufacturer: string | null;
  packSize: number;
  defaultSellUnit: SellUnit;
  shelfLocation: string | null;
  barcode: string | null;
  requiresPrescription: boolean;
  reorderLevel: number;
  unitPrice: string;
  vatTreatment: VatTreatment;
  isActive: boolean;
}

/**
 * The editable product fields.
 *
 * The four derived columns are absent on purpose. Their absence is the
 * guarantee: a field that is not in this type cannot be passed to `updateProduct`
 * by a route that forgot to discard it, and the compiler says so rather than a
 * reviewer having to notice.
 */
export interface ProductPatch {
  name?: string;
  genericName?: string | null;
  category?: string | null;
  manufacturer?: string | null;
  packSize?: number;
  defaultSellUnit?: SellUnit;
  shelfLocation?: string | null;
  barcode?: string | null;
  requiresPrescription?: boolean;
  reorderLevel?: number;
  unitPrice?: string;
  vatTreatment?: VatTreatment;
  isActive?: boolean;
}

export interface ProductFilters {
  /** Matched against name, code, generic name and barcode. */
  search?: string;
  category?: string;
  /** When false, inactive products are excluded. */
  includeInactive?: boolean;
  limit: number;
  offset: number;
}

export interface NewBatch {
  pharmacyId: string;
  inventoryId: string;
  lotNumber: string;
  expiryDate: string | null;
  quantity: number;
  costPrice: string;
  /** ISO-8601. The FEFO tie-break, and rejected by the API when it is in the future. */
  receivedAt: string;
}

export interface NewMovement {
  pharmacyId: string;
  inventoryId: string;
  batchId: string | null;
  saleId?: string | null;
  movementType: MovementType;
  /** Signed. Positive for stock arriving, negative for stock leaving. */
  quantityChange: number;
  /** The batch's quantity after this movement. */
  quantityAfter: number;
  reason: string | null;
  note: string | null;
  performedBy: string;
}

export interface MovementRow {
  id: string;
  pharmacyId: string;
  inventoryId: string;
  batchId: string | null;
  saleId: string | null;
  movementType: MovementType;
  quantityChange: number;
  quantityAfter: number;
  reason: string | null;
  note: string | null;
  performedBy: string;
  performedByName: string | null;
  createdAt: string;
}

export interface RecallSaleRow {
  saleId: string;
  saleNumber: string;
  status: SaleStatus;
  soldAt: string;
  /** Base units this sale took from the recalled batch. */
  units: number;
  unitCost: string;
  description: string;
  sellUnit: SellUnit;
  servedBy: string;
  patientName: string | null;
  patientPhone: string | null;
}

/** `timestamptz` arrives as a `Date`; the API speaks ISO-8601 strings. */
function toIso(value: Date): string {
  return value.toISOString();
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapProduct(row: Record<string, unknown>): ProductRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    name: row.name as string,
    code: row.code as string,
    genericName: textOrNull(row.generic_name),
    category: textOrNull(row.category),
    manufacturer: textOrNull(row.manufacturer),
    packSize: row.pack_size as number,
    defaultSellUnit: row.default_sell_unit as SellUnit,
    shelfLocation: textOrNull(row.shelf_location),
    barcode: textOrNull(row.barcode),
    requiresPrescription: row.requires_prescription as boolean,
    reorderLevel: row.reorder_level as number,
    unitPrice: row.unit_price as string,
    vatTreatment: row.vat_treatment as VatTreatment,
    isActive: row.is_active as boolean,
    quantity: row.quantity as number,
    batchNumber: textOrNull(row.batch_number),
    expiryDate: textOrNull(row.expiry_date),
    costPrice: row.cost_price as string,
    createdAt: toIso(row.created_at as Date),
    updatedAt: toIso(row.updated_at as Date),
  };
}

function mapBatch(row: Record<string, unknown>): BatchRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    inventoryId: row.inventory_id as string,
    lotNumber: row.lot_number as string,
    expiryDate: textOrNull(row.expiry_date),
    quantity: row.quantity as number,
    costPrice: row.cost_price as string,
    receivedAt: toIso(row.received_at as Date),
    createdAt: toIso(row.created_at as Date),
    updatedAt: toIso(row.updated_at as Date),
  };
}

/**
 * Wraps a search term for `ILIKE`.
 *
 * `%` and `_` are wildcards and `\` is the escape character, so a term left
 * unescaped changes what the search means rather than what it matches: looking
 * for "50%" would return every product in the pharmacy. Escaping makes the
 * search literal, which is what a person typing into a search box expects.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export async function listProducts(
  sql: Sql,
  pharmacyId: string,
  filters: ProductFilters
): Promise<ProductRow[]> {
  const values: unknown[] = [pharmacyId];
  const push = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const where: string[] = ['pharmacy_id = $1'];
  if (filters.includeInactive !== true) where.push('is_active = true');
  if (filters.category !== undefined) where.push(`category = ${push(filters.category)}`);
  if (filters.search !== undefined && filters.search !== '') {
    // One parameter used in four predicates, all of them `ilike` against a text
    // column, so the parser deduces text once and consistently. NULL columns
    // yield NULL rather than false, which an OR absorbs.
    const term = push(likePattern(filters.search));
    where.push(`(name ilike ${term} or code ilike ${term} or generic_name ilike ${term} or barcode ilike ${term})`);
  }

  const result = await sql.query(
    `select ${PRODUCT_COLUMNS} from inventory
      where ${where.join(' and ')}
      order by name, code
      limit ${push(filters.limit)} offset ${push(filters.offset)}`,
    values
  );
  return result.rows.map(mapProduct);
}

export async function findProductById(
  sql: Sql,
  pharmacyId: string,
  id: string
): Promise<ProductRow | null> {
  const result = await sql.query(
    `select ${PRODUCT_COLUMNS} from inventory where pharmacy_id = $1 and id = $2`,
    [pharmacyId, id]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapProduct(first);
}

/**
 * Looks a product up by its code.
 *
 * Exact match, because `unique (pharmacy_id, code)` is exact. A case-insensitive
 * lookup against a case-sensitive constraint would be worse than either: it would
 * find `abc-1` for `ABC-1` while an INSERT of `abc-1` still created a second
 * product. Making the two agree means changing the constraint, which is a
 * migration and a decision for when it actually costs A&B something.
 */
export async function findProductByCode(
  sql: Sql,
  pharmacyId: string,
  code: string
): Promise<ProductRow | null> {
  const result = await sql.query(
    `select ${PRODUCT_COLUMNS} from inventory where pharmacy_id = $1 and code = $2`,
    [pharmacyId, code]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapProduct(first);
}

/**
 * Holds the product row until the transaction ends.
 *
 * Receive, adjust and write-off all read a batch and then write it. Without the
 * lock two of them running at once — or one of them against a sale drawing from
 * the same batch — interleave, and the last writer's `quantity_after` is a
 * figure no batch ever held. Locking the product rather than the batch covers
 * every batch of that product in one lock, and a sale touches the product row
 * anyway through the derived-stock trigger, so this adds no contention that was
 * not already there.
 */
export async function lockProduct(
  sql: Sql,
  pharmacyId: string,
  id: string
): Promise<ProductRow | null> {
  const result = await sql.query(
    `select ${PRODUCT_COLUMNS} from inventory
      where pharmacy_id = $1 and id = $2
      for update`,
    [pharmacyId, id]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapProduct(first);
}

export async function createProduct(
  sql: Sql,
  input: NewProduct
): Promise<ProductRow> {
  try {
    const result = await sql.query(
      `insert into inventory
         (pharmacy_id, name, code, generic_name, category, manufacturer, pack_size,
          default_sell_unit, shelf_location, barcode, requires_prescription,
          reorder_level, unit_price, vat_treatment, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       returning ${PRODUCT_COLUMNS}`,
      [
        input.pharmacyId,
        input.name,
        input.code,
        input.genericName,
        input.category,
        input.manufacturer,
        input.packSize,
        input.defaultSellUnit,
        input.shelfLocation,
        input.barcode,
        input.requiresPrescription,
        input.reorderLevel,
        input.unitPrice,
        input.vatTreatment,
        input.isActive,
      ]
    );
    const inserted = result.rows[0];
    if (inserted === undefined) {
      throw new Error('insert into inventory returned no row');
    }
    return mapProduct(inserted);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new HttpError(409, 'A product with that code already exists', {
        code: 'product_code_taken',
      });
    }
    throw error;
  }
}

export async function updateProduct(
  sql: Sql,
  pharmacyId: string,
  id: string,
  patch: ProductPatch
): Promise<ProductRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown): string => {
    values.push(value);
    return `${column} = $${values.length}`;
  };

  if (patch.name !== undefined) sets.push(push('name', patch.name));
  if (patch.genericName !== undefined) sets.push(push('generic_name', patch.genericName));
  if (patch.category !== undefined) sets.push(push('category', patch.category));
  if (patch.manufacturer !== undefined) sets.push(push('manufacturer', patch.manufacturer));
  if (patch.packSize !== undefined) sets.push(push('pack_size', patch.packSize));
  if (patch.defaultSellUnit !== undefined) {
    sets.push(push('default_sell_unit', patch.defaultSellUnit));
  }
  if (patch.shelfLocation !== undefined) sets.push(push('shelf_location', patch.shelfLocation));
  if (patch.barcode !== undefined) sets.push(push('barcode', patch.barcode));
  if (patch.requiresPrescription !== undefined) {
    sets.push(push('requires_prescription', patch.requiresPrescription));
  }
  if (patch.reorderLevel !== undefined) sets.push(push('reorder_level', patch.reorderLevel));
  if (patch.unitPrice !== undefined) sets.push(push('unit_price', patch.unitPrice));
  if (patch.vatTreatment !== undefined) sets.push(push('vat_treatment', patch.vatTreatment));
  if (patch.isActive !== undefined) sets.push(push('is_active', patch.isActive));

  if (sets.length === 0) {
    return findProductById(sql, pharmacyId, id);
  }

  // No `updated_at` in the SET list. The `set_updated_at` BEFORE trigger stamps
  // it with `clock_timestamp()` on every update, so a value supplied here would
  // be overwritten by the database clock anyway — and the database clock is the
  // one worth having, because it does not depend on the app server's.
  values.push(pharmacyId, id);
  const result = await sql.query(
    `update inventory
        set ${sets.join(', ')}
      where pharmacy_id = $${values.length - 1} and id = $${values.length}
      returning ${PRODUCT_COLUMNS}`,
    values
  );
  const first = result.rows[0];
  return first === undefined ? null : mapProduct(first);
}

/**
 * Every batch of a product, in the FEFO order.
 *
 * `expiry_date nulls last, received_at, id` is `utils/fefo.ts`'s `compareFefo`
 * written in SQL, and the two must not drift: this order decides which lot the
 * batch panel shows first, and the allocator decides which lot the till draws
 * from. They disagree and the screen shows one lot while the sale takes another.
 * The index `inventory_batches_fefo_idx` carries the same three columns in the
 * same order, so this is an index scan rather than a sort.
 */
export async function listBatchesForProduct(
  sql: Sql,
  pharmacyId: string,
  inventoryId: string
): Promise<BatchRow[]> {
  const result = await sql.query(
    `select ${BATCH_COLUMNS} from inventory_batches
      where pharmacy_id = $1 and inventory_id = $2
      order by expiry_date nulls last, received_at, id`,
    [pharmacyId, inventoryId]
  );
  return result.rows.map(mapBatch);
}

/** Every batch in the pharmacy that still holds stock, for the alert scan. */
export async function listBatchesHoldingStock(
  sql: Sql,
  pharmacyId: string
): Promise<BatchRow[]> {
  const result = await sql.query(
    `select ${BATCH_COLUMNS} from inventory_batches
      where pharmacy_id = $1 and quantity > 0
      order by inventory_id, expiry_date nulls last, received_at, id`,
    [pharmacyId]
  );
  return result.rows.map(mapBatch);
}

/** Every active product, for the alert scan. */
export async function listActiveProducts(sql: Sql, pharmacyId: string): Promise<ProductRow[]> {
  const result = await sql.query(
    `select ${PRODUCT_COLUMNS} from inventory
      where pharmacy_id = $1 and is_active = true
      order by name, code`,
    [pharmacyId]
  );
  return result.rows.map(mapProduct);
}

/**
 * The distinct categories a pharmacy actually has stock under, for the till's
 * filter chips.
 *
 * `distinct` over the products rather than a lookup table, because the category is
 * free text on the product and there is no list to keep in step with it. A chip
 * that filters to nothing is worse than no chip: it reads as "we sell this" and
 * then shows an empty grid.
 *
 * Inactive products are included. A category whose only products are inactive is
 * still a category the till has been showing, and hiding it the day the last one
 * was retired changes the screen under somebody's finger mid-sale. The grid itself
 * filters on `is_active`.
 */
export async function listCategories(sql: Sql, pharmacyId: string): Promise<string[]> {
  const result = await sql.query(
    `select distinct category from inventory
      where pharmacy_id = $1 and category is not null and category <> ''
      order by category`,
    [pharmacyId]
  );
  return result.rows.map((row) => row.category as string);
}

export async function findBatch(
  sql: Sql,
  pharmacyId: string,
  batchId: string
): Promise<BatchRow | null> {
  const result = await sql.query(
    `select ${BATCH_COLUMNS} from inventory_batches where pharmacy_id = $1 and id = $2`,
    [pharmacyId, batchId]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapBatch(first);
}

/**
 * The lot a receive should merge into, or null when this lot is new.
 *
 * Scoped by product as well as lot, matching `unique (pharmacy_id,
 * inventory_id, lot_number)`. The same lot number on two different products is
 * two batches, not a collision.
 */
export async function findBatchByLot(
  sql: Sql,
  pharmacyId: string,
  inventoryId: string,
  lotNumber: string
): Promise<BatchRow | null> {
  const result = await sql.query(
    `select ${BATCH_COLUMNS} from inventory_batches
      where pharmacy_id = $1 and inventory_id = $2 and lot_number = $3`,
    [pharmacyId, inventoryId, lotNumber]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapBatch(first);
}

export async function insertBatch(sql: Sql, input: NewBatch): Promise<BatchRow> {
  try {
    const result = await sql.query(
      `insert into inventory_batches
         (pharmacy_id, inventory_id, lot_number, expiry_date, quantity, cost_price, received_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${BATCH_COLUMNS}`,
      [
        input.pharmacyId,
        input.inventoryId,
        input.lotNumber,
        input.expiryDate,
        input.quantity,
        input.costPrice,
        input.receivedAt,
      ]
    );
    const inserted = result.rows[0];
    if (inserted === undefined) {
      throw new Error('insert into inventory_batches returned no row');
    }
    return mapBatch(inserted);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new HttpError(409, 'That lot number already exists for this product', {
        code: 'lot_taken',
      });
    }
    throw error;
  }
}

/**
 * Adds stock to an existing batch and re-prices it.
 *
 * Merging two lots into one drawer makes one batch whose cost is the
 * quantity-weighted average of the two: ten units at 2.00 plus five at 3.00 is
 * fifteen at 2.3333. Keeping the old cost would overstate margin on everything
 * sold from the drawer afterwards, and taking the new cost would understate it.
 * The weighted average is also exactly what `recompute_inventory_from_batches`
 * does at product level, and `round(..., 4)` is the same rounding to the same
 * number of places, so the batch figures and the product figure agree.
 *
 * Both SET expressions read the row as it was before the update — that is
 * Postgres's rule, not an accident of ordering — so `quantity` inside the
 * cost expression is the old quantity even though `quantity` is also being set.
 * Section 10 of the harness asserts the resulting figure on a real server.
 *
 * `$2` is used as an integer in `quantity + $2` and multiplied by a numeric
 * below; it is deduced integer from the first use and the multiplication
 * promotes it. `$3` is cast because it is money and must not be deduced as an
 * integer by an `integer * unknown` operator resolution, which would silently
 * truncate every cost price to whole cedis.
 */
export async function mergeIntoBatch(
  sql: Sql,
  batchId: string,
  addQuantity: number,
  addCostPrice: string
): Promise<BatchRow | null> {
  const result = await sql.query(
    `update inventory_batches
        set quantity = quantity + $2,
            cost_price = round(((quantity * cost_price) + ($2 * $3::numeric)) / (quantity + $2), 4)
      where id = $1
      returning ${BATCH_COLUMNS}`,
    [batchId, addQuantity, addCostPrice]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapBatch(first);
}

/**
 * Sets a batch to an absolute quantity. Used by adjust and by write-off, which
 * differ in the ledger row written beside it and in who may call it, not in the
 * arithmetic.
 *
 * The caller must hold the product lock first: this is the write half of a
 * read-modify-write.
 */
export async function setBatchQuantity(
  sql: Sql,
  batchId: string,
  quantity: number
): Promise<BatchRow | null> {
  const result = await sql.query(
    `update inventory_batches set quantity = $2 where id = $1 returning ${BATCH_COLUMNS}`,
    [batchId, quantity]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapBatch(first);
}

export async function insertMovement(
  sql: Sql,
  input: NewMovement
): Promise<void> {
  await sql.query(
    `insert into stock_movements
       (pharmacy_id, inventory_id, batch_id, sale_id, movement_type, quantity_change,
        quantity_after, reason, note, performed_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.pharmacyId,
      input.inventoryId,
      input.batchId,
      input.saleId ?? null,
      input.movementType,
      input.quantityChange,
      input.quantityAfter,
      input.reason,
      input.note,
      input.performedBy,
    ]
  );
}

export async function listMovements(
  sql: Sql,
  pharmacyId: string,
  inventoryId: string,
  limit: number
): Promise<MovementRow[]> {
  const result = await sql.query(
    `select ${MOVEMENT_COLUMNS.split(',').map((column) => `m.${column.trim()}`).join(', ')},
            u.full_name as performed_by_name
       from stock_movements m
       join users u on u.id = m.performed_by
      where m.pharmacy_id = $1 and m.inventory_id = $2
      order by m.created_at desc, m.id desc
      limit $3`,
    [pharmacyId, inventoryId, limit]
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    inventoryId: row.inventory_id as string,
    batchId: textOrNull(row.batch_id),
    saleId: textOrNull(row.sale_id),
    movementType: row.movement_type as MovementType,
    quantityChange: row.quantity_change as number,
    quantityAfter: row.quantity_after as number,
    reason: textOrNull(row.reason),
    note: textOrNull(row.note),
    performedBy: row.performed_by as string,
    performedByName: textOrNull(row.performed_by_name),
    createdAt: toIso(row.created_at as Date),
  }));
}

/**
 * Every sale that contained a batch, and who to contact about each one.
 *
 * Voided sales are included and carry their status, rather than being filtered
 * out. A recall is a safety operation and quietly dropping records is the wrong
 * default: a voided sale usually means the goods came back, but "usually" is
 * not something to act on when the question is who may have taken a recalled
 * lot. The UI shows the status and the person decides.
 *
 * Scoping runs through `sales.pharmacy_id`, because `sale_item_batches` has no
 * pharmacy column of its own and a batch id from another tenant must not answer
 * here.
 */
export async function recallTrace(
  sql: Sql,
  pharmacyId: string,
  batchId: string
): Promise<RecallSaleRow[]> {
  const result = await sql.query(
    `select s.id as sale_id, s.sale_number, s.status, s.created_at as sold_at,
            sib.quantity as units, sib.unit_cost,
            si.description, si.sell_unit,
            u.full_name as served_by,
            p.full_name as patient_name, p.phone as patient_phone
       from sale_item_batches sib
       join sale_items si on si.id = sib.sale_item_id
       join sales s on s.id = si.sale_id
       join users u on u.id = s.served_by
       left join patients p on p.id = s.patient_id
      where sib.batch_id = $1
        and s.pharmacy_id = $2
      order by s.created_at desc, s.id desc`,
    [batchId, pharmacyId]
  );
  return result.rows.map((row) => ({
    saleId: row.sale_id as string,
    saleNumber: row.sale_number as string,
    status: row.status as SaleStatus,
    soldAt: toIso(row.sold_at as Date),
    units: row.units as number,
    unitCost: row.unit_cost as string,
    description: row.description as string,
    sellUnit: row.sell_unit as SellUnit,
    servedBy: row.served_by as string,
    patientName: textOrNull(row.patient_name),
    patientPhone: textOrNull(row.patient_phone),
  }));
}
