jest.mock('../database/pool', () => ({
  poolSql: { query: jest.fn() },
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn(),
  withSavepoint: jest.fn(),
  probeDatabase: jest.fn().mockResolvedValue({ ok: true }),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

jest.mock('../repositories/users.repository', () => ({
  findUserById: jest.fn(),
  findUserByEmail: jest.fn(),
  listStaff: jest.fn(),
  createStaff: jest.fn(),
  countActiveOwners: jest.fn(),
  updateStaff: jest.fn(),
  setPassword: jest.fn(),
  markLogin: jest.fn(),
  bumpSessionVersion: jest.fn(),
}));

jest.mock('../repositories/inventory.repository', () => ({
  createProduct: jest.fn(),
  findBatch: jest.fn(),
  findBatchByLot: jest.fn(),
  findProductByCode: jest.fn(),
  findProductById: jest.fn(),
  insertBatch: jest.fn(),
  insertMovement: jest.fn(),
  likePattern: (term: string) => `%${term}%`,
  listActiveProducts: jest.fn(),
  listBatchesForProduct: jest.fn(),
  listBatchesHoldingStock: jest.fn(),
  listCategories: jest.fn(),
  listMovements: jest.fn(),
  listProducts: jest.fn(),
  lockProduct: jest.fn(),
  mergeIntoBatch: jest.fn(),
  recallTrace: jest.fn(),
  setBatchQuantity: jest.fn(),
  updateProduct: jest.fn(),
}));

jest.mock('../repositories/sales.repository', () => ({
  findSaleById: jest.fn(),
  findSaleByClientSaleId: jest.fn(),
  findSalePayment: jest.fn(),
  findSalePaymentByReference: jest.fn(),
  insertSale: jest.fn(),
  insertSaleItem: jest.fn(),
  insertSaleItemBatch: jest.fn(),
  insertSalePayment: jest.fn(),
  listSaleItemBatches: jest.fn(),
  listSaleItems: jest.fn(),
  listSalePayments: jest.fn(),
  listSales: jest.fn(),
  lockSale: jest.fn(),
  markSaleVoided: jest.fn(),
  nextSaleNumber: jest.fn(),
  patientExists: jest.fn(),
  updateSalePaymentStatus: jest.fn(),
  updateSaleSettlement: jest.fn(),
}));

jest.mock('../repositories/tax-settings.repository', () => ({
  readTaxSettings: jest.fn(),
  writeTaxSettings: jest.fn(),
}));

// Spied rather than replaced, so the routes still get real dates and the suite
// can assert on *which* `Date` they were derived from. That is the only way to
// see the "one clock read" rule from outside: two independent `new Date()` calls
// produce two objects that are `===`-distinct even when they read the same
// millisecond, so a spy that records the argument catches a straddle-midnight
// bug that comparing the two returned strings never would.
jest.mock('../utils/clock', () => {
  const actual = jest.requireActual('../utils/clock') as {
    todayDateOnly: (now?: Date) => string;
    nowIso: (now?: Date) => string;
  };
  return {
    todayDateOnly: jest.fn(actual.todayDateOnly),
    nowIso: jest.fn(actual.nowIso),
  };
});

import request from 'supertest';
import { createApp } from '../app';
import { withTransaction } from '../database/pool';
import {
  findProductById,
  listCategories,
  listBatchesForProduct,
  listBatchesHoldingStock,
  listProducts as queryProducts,
  lockProduct,
  setBatchQuantity,
  type BatchRow,
  type ProductRow,
} from '../repositories/inventory.repository';
import {
  findSaleByClientSaleId,
  findSaleById,
  findSalePayment,
  insertSale,
  insertSaleItem,
  insertSaleItemBatch,
  insertSalePayment,
  listSaleItemBatches,
  listSaleItems,
  listSalePayments,
  listSales as querySales,
  lockSale,
  markSaleVoided,
  nextSaleNumber,
  patientExists,
  updateSalePaymentStatus,
  updateSaleSettlement,
  type SaleItemBatchRow,
  type SaleItemRow,
  type SalePaymentRow,
  type SaleRow,
} from '../repositories/sales.repository';
import { readTaxSettings, type TaxSettingsRow } from '../repositories/tax-settings.repository';
import { findUserById, listStaff, type UserRow } from '../repositories/users.repository';
import { HttpError } from '../utils/http';
import { signAccessToken } from '../utils/jwt';
import { todayDateOnly, nowIso } from '../utils/clock';
import type { Permission, UserRole } from '../utils/permissions';
import type { SaleStatus } from '../utils/schema-enums';

/**
 * The till, over HTTP.
 *
 * The repositories and the pool are mocked. **The services are not**, and the
 * guarantees below are only visible because of that:
 *
 * - The mobile money reference is minted server-side. `readTender` discards the
 *   caller's value and `newPaymentReference` replaces it. Mocking the service
 *   would assert that the route forwards a body, which is true and worthless —
 *   the whole premise of the webhook path is that the reference in the row is
 *   one no client chose.
 * - `POST /sales/quote` writes nothing. Only the absence of a call into
 *   `withTransaction` and every insert proves it, and only the real service can
 *   produce that absence.
 * - Route order. `GET /sales/products` reaches `/:id` with `id = "products"` if
 *   the literal path is declared second. Nothing below the router can detect it.
 * - The clock is read once per request, so a sale cannot be FEFO-judged against
 *   yesterday and timestamped today.
 *
 * What is mocked is the SQL, and that the SQL is valid is
 * `sales.repository.test.ts` and the harness in `database/tests`.
 *
 * ## Breaking the mint takes two edits, and that was verified rather than assumed
 *
 * This suite was run with `referenceFor` changed to prefer the caller's value
 * over a minted one. Nothing failed, because `readTender` has already set the
 * note to null on a mobile money tender and there is nothing left to prefer.
 * Removing that discard as well is what turned "mints the mobile money
 * reference itself" red — and it is the only break of the six this suite was
 * seen red for that needed two edits in two functions.
 *
 * Two independent layers holding one property is good. A green suite proving
 * the property is guarded is not something either layer can offer on its own,
 * so this note is here to stop a reader concluding otherwise from a break that
 * did not fail.
 */

const app = createApp();

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const CASHIER_ID = 'a0000000-0000-4000-8000-000000000004';
const PRODUCT = 'a0000000-0000-4000-8000-000000000010';
const BATCH = 'a0000000-0000-4000-8000-000000000020';
const SALE = 'a0000000-0000-4000-8000-000000000030';
const ITEM = 'a0000000-0000-4000-8000-000000000031';
const JOIN_ROW = 'a0000000-0000-4000-8000-000000000032';
const PAYMENT = 'a0000000-0000-4000-8000-000000000050';

const SALE_NUMBER = 'H3-000042';
const CLIENT_SALE_ID = 'till-7f3c1b90-4d2e';
const CREATED_AT = '2026-09-04T09:12:00.000Z';

/**
 * Far enough ahead that this suite does not start failing on a date. The routes
 * read today from the real clock, so an expiry a few months out would quietly
 * become an expired lot and change what `available` reports.
 */
const FUTURE = '2099-12-31';

const CLIENT = { query: jest.fn() };

const withTransactionMock = jest.mocked(withTransaction);
const queryProductsMock = jest.mocked(queryProducts);
const findProductByIdMock = jest.mocked(findProductById);
const listBatchesHoldingStockMock = jest.mocked(listBatchesHoldingStock);
const listCategoriesMock = jest.mocked(listCategories);
const lockProductMock = jest.mocked(lockProduct);
const listBatchesForProductMock = jest.mocked(listBatchesForProduct);
const setBatchQuantityMock = jest.mocked(setBatchQuantity);
const nextSaleNumberMock = jest.mocked(nextSaleNumber);
const insertSaleMock = jest.mocked(insertSale);
const insertSaleItemMock = jest.mocked(insertSaleItem);
const insertSaleItemBatchMock = jest.mocked(insertSaleItemBatch);
const insertSalePaymentMock = jest.mocked(insertSalePayment);
const findSaleByIdMock = jest.mocked(findSaleById);
const findSaleByClientSaleIdMock = jest.mocked(findSaleByClientSaleId);
const listSaleItemsMock = jest.mocked(listSaleItems);
const listSaleItemBatchesMock = jest.mocked(listSaleItemBatches);
const listSalePaymentsMock = jest.mocked(listSalePayments);
const querySalesMock = jest.mocked(querySales);
const lockSaleMock = jest.mocked(lockSale);
const markSaleVoidedMock = jest.mocked(markSaleVoided);
const updateSaleSettlementMock = jest.mocked(updateSaleSettlement);
const findSalePaymentMock = jest.mocked(findSalePayment);
const updateSalePaymentStatusMock = jest.mocked(updateSalePaymentStatus);
const patientExistsMock = jest.mocked(patientExists);
const readTaxSettingsMock = jest.mocked(readTaxSettings);
const findUserByIdMock = jest.mocked(findUserById);
const listStaffMock = jest.mocked(listStaff);
const todayDateOnlyMock = jest.mocked(todayDateOnly);
const nowIsoMock = jest.mocked(nowIso);

function userRow(id: string, role: UserRole, overrides: Partial<UserRow> = {}): UserRow {
  return {
    id,
    pharmacyId: PHARMACY,
    fullName: role === 'pharmacy_owner' ? 'Beatrice Owusu' : role,
    email: `${id}@aandb.example`,
    phone: null,
    role,
    passwordHash: '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS',
    isActive: true,
    sessionVersion: 2,
    lastLoginAt: null,
    ...overrides,
  };
}

/**
 * Paracetamol, exempt and priced per base unit.
 *
 * `vatTreatment: 'exempt'` is deliberate: the tax engine has 192 tests of its
 * own in the shared package, and a route suite that also had to predict its
 * output would fail for a reason that has nothing to do with routing. Two
 * singles at 12.50 is 25.00 and nothing else, so every money assertion below is
 * arithmetic a reader can do in their head.
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
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
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
    receivedAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function saleRow(overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    id: SALE,
    pharmacyId: PHARMACY,
    saleNumber: SALE_NUMBER,
    status: 'completed',
    servedBy: OWNER_ID,
    approvedBy: null,
    patientId: null,
    subtotal: '25.00',
    discount: '0.00',
    discountReason: null,
    vatAmount: '0.00',
    nhilAmount: '0.00',
    getfundAmount: '0.00',
    taxTotal: '0.00',
    total: '25.00',
    amountPaid: '25.00',
    changeGiven: '0.00',
    vatRate: '0.1500',
    nhilRate: '0.0250',
    getfundRate: '0.0250',
    taxInclusivePricing: false,
    clientSaleId: CLIENT_SALE_ID,
    voidedAt: null,
    voidReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function saleItem(overrides: Partial<SaleItemRow> = {}): SaleItemRow {
  return {
    id: ITEM,
    saleId: SALE,
    inventoryId: PRODUCT,
    description: 'Paracetamol 500mg',
    sellUnit: 'single',
    quantity: 2,
    unitPrice: '12.50',
    lineGross: '25.00',
    lineDiscount: '0.00',
    taxableBase: '0.00',
    vatAmount: '0.00',
    nhilAmount: '0.00',
    getfundAmount: '0.00',
    lineTotal: '25.00',
    vatTreatment: 'exempt',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function saleItemBatch(overrides: Partial<SaleItemBatchRow> = {}): SaleItemBatchRow {
  return {
    id: JOIN_ROW,
    saleItemId: ITEM,
    batchId: BATCH,
    lotNumber: 'LOT-1',
    quantity: 2,
    unitCost: '8.2500',
    ...overrides,
  };
}

function paymentRow(overrides: Partial<SalePaymentRow> = {}): SalePaymentRow {
  return {
    id: PAYMENT,
    saleId: SALE,
    method: 'cash',
    status: 'succeeded',
    amount: '25.00',
    reference: null,
    gatewayResponse: null,
    paidAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/**
 * What `findSalePayment` actually returns: the tender, plus the two facts the
 * verify path needs without a second query — whose pharmacy the sale belongs
 * to, and whether that sale is still open to a payment.
 *
 * The extra pair is why this is a second helper rather than an override on
 * `paymentRow`. `saleStatus` decides between `sale_not_open` and the amount
 * check, so a fixture that could not express it would leave the more
 * interesting branch of `confirmCharge` unreachable from this suite.
 */
function lockedPayment(
  overrides: Partial<SalePaymentRow> = {},
  sale: { saleStatus?: SaleStatus } = {}
): SalePaymentRow & { pharmacyId: string; saleStatus: SaleStatus } {
  return {
    ...paymentRow(overrides),
    pharmacyId: PHARMACY,
    saleStatus: sale.saleStatus ?? 'pending',
  };
}

function tokenFor(id: string, role: UserRole): string {
  return signAccessToken({ userId: id, pharmacyId: PHARMACY, role, sessionVersion: 2 });
}

const ROLES: ReadonlyArray<[UserRole, () => string]> = [
  ['pharmacy_owner', () => tokenFor(OWNER_ID, 'pharmacy_owner')],
  ['pharmacist', () => tokenFor(PHARMACIST_ID, 'pharmacist')],
  ['staff', () => tokenFor(CASHIER_ID, 'staff')],
];

function send(
  method: 'get' | 'post',
  path: string,
  token: string | undefined,
  body?: object
): request.Test {
  const agent = request(app);
  const test = method === 'get' ? agent.get(path) : agent.post(path);
  if (token !== undefined) test.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) test.send(body);
  return test;
}

interface ErrorBody {
  success: false;
  /**
   * `unknown` rather than one shape, because three arrive here and all are
   * correct: a `{ field, message }` list from validation, `{ missing: [...] }`
   * from `authorize`, and the `details` a service attaches to an `HttpError`.
   * Typing it as one would make the others a cast, and a cast in a test is an
   * assertion nobody checks.
   */
  error: { message: string; code?: string; details?: unknown };
}

const errorOf = (body: unknown): ErrorBody => body as ErrorBody;

/** Two singles of an exempt product: 25.00 and no tax. */
const BASKET = { lines: [{ productId: PRODUCT, quantity: 2 }] };

/**
 * The till's route table, hand-written.
 *
 * Not read from `salesRoutes.stack`: a table read from the source agrees with
 * the source by construction, so a route whose `authorize` was dropped would
 * change the table and the assertion together and stay green. This is the spec,
 * and the code is checked against it.
 */
const ROUTE_TABLE: ReadonlyArray<{
  name: string;
  method: 'get' | 'post';
  path: string;
  permission: Permission;
}> = [
  { name: 'products', method: 'get', path: '/sales/products', permission: 'sales:read' },
  { name: 'categories', method: 'get', path: '/sales/categories', permission: 'sales:read' },
  { name: 'payment config', method: 'get', path: '/sales/payment-config', permission: 'sales:read' },
  { name: 'approvers', method: 'get', path: '/sales/approvers', permission: 'sales:read' },
  { name: 'quote', method: 'post', path: '/sales/quote', permission: 'sales:read' },
  { name: 'list', method: 'get', path: '/sales', permission: 'sales:read' },
  { name: 'create', method: 'post', path: '/sales', permission: 'sales:create' },
  {
    name: 'verify payment',
    method: 'post',
    path: `/sales/payments/${PAYMENT}/verify`,
    permission: 'payments:verify',
  },
  { name: 'sale detail', method: 'get', path: `/sales/${SALE}`, permission: 'sales:read' },
  {
    name: 'add payment',
    method: 'post',
    path: `/sales/${SALE}/payments`,
    permission: 'payments:add',
  },
  { name: 'void', method: 'post', path: `/sales/${SALE}/void`, permission: 'sales:void' },
];

/**
 * Who is refused what, written out rather than derived from `can()`.
 *
 * Deriving it would make this suite agree with `utils/permissions.ts` by
 * construction, and the point of the matrix is that a route consults a map
 * somebody else pinned. Every route not named here denies nobody — which is a
 * claim about all three roles, not an absence of a claim.
 *
 * `sales:void` is one of the five things the brief makes owner-only.
 * `payments:verify` is not owner-only but counter staff do not hold it, so a
 * cashier whose mobile money prompt times out has to hand the sale to a
 * pharmacist — and the till has to say that in words rather than show 403.
 */
const DENIED: Readonly<Record<string, UserRole[]>> = {
  'verify payment': ['staff'],
  void: ['pharmacist', 'staff'],
};

/**
 * One row standing in for the `sales` table, and the reason the assertions
 * about what came *back* are worth anything.
 *
 * `detail()` reads the sale again after the write, so a fixture that could not
 * change would answer every read from the same static row: a route that had
 * just voided a sale would hand back `completed`, and a test asserting the
 * read-back would be asserting the fixture. Each write mock below moves this
 * row the way its own statement does — including the `status <> 'voided'`
 * guard, which is the whole of the double-void protection and is in the
 * statement rather than in the service that calls it.
 *
 * Reset in `beforeEach` and only ever read through a mock, so a test sets up
 * the state a sale is in by assigning to this rather than by configuring a
 * return value. That is also why `lockSale` reads it: one row means the
 * pre-write lock and the post-write read-back cannot disagree, and a fixture
 * that could disagree would let a test pass against a database state Postgres
 * would never be in.
 */
let stored: SaleRow = saleRow();

/** Rung up and not yet paid: the state a sale is in while it takes money. */
const OPEN_SALE: Partial<SaleRow> = { status: 'pending', amountPaid: '0.00' };

beforeEach(() => {
  jest.clearAllMocks();
  stored = saleRow();

  const users: Record<string, UserRow> = {
    [OWNER_ID]: userRow(OWNER_ID, 'pharmacy_owner'),
    [PHARMACIST_ID]: userRow(PHARMACIST_ID, 'pharmacist'),
    [CASHIER_ID]: userRow(CASHIER_ID, 'staff'),
  };
  findUserByIdMock.mockImplementation(async (id: string) => users[id] ?? null);
  listStaffMock.mockResolvedValue(Object.values(users));

  // The transaction runs its work against `CLIENT`, so every repository call is
  // observable and a rollback is not something this suite has to simulate: a
  // service that throws simply never returns from `withTransaction`.
  withTransactionMock.mockImplementation(async (work) =>
    work(CLIENT as unknown as Parameters<typeof work>[0])
  );

  readTaxSettingsMock.mockResolvedValue({
    pharmacyId: PHARMACY,
    taxInclusivePricing: false,
    vatRate: '0.1500',
    nhilRate: '0.0250',
    getfundRate: '0.0250',
    updatedAt: CREATED_AT,
  } as TaxSettingsRow);

  queryProductsMock.mockResolvedValue([product()]);
  // The quote path reads a product with `findProductById` and the write path
  // with `lockProduct`, and both need a default. A `jest.fn()` with no
  // implementation resolves to `undefined`, and `quoteSale` reads `.isActive`
  // off it — a 500 on the one endpoint BRIEF.md's landmine 9 exists to keep
  // usable while everything else is broken.
  findProductByIdMock.mockResolvedValue(product());
  listBatchesHoldingStockMock.mockResolvedValue([batch()]);
  listCategoriesMock.mockResolvedValue(['Analgesic']);
  lockProductMock.mockResolvedValue(product());
  listBatchesForProductMock.mockResolvedValue([batch()]);
  setBatchQuantityMock.mockResolvedValue(batch({ quantity: 98 }));

  nextSaleNumberMock.mockResolvedValue(SALE_NUMBER);
  insertSaleMock.mockImplementation(async (_sql, input) => {
    stored = saleRow({
      ...input,
      id: SALE,
      voidedAt: null,
      voidReason: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    return stored;
  });
  insertSaleItemMock.mockResolvedValue(saleItem());
  // `Promise<void>`, so the honest resolved value is `undefined`. Asserting the
  // insert happened is the assertion; a returned row would be one nothing reads.
  insertSaleItemBatchMock.mockResolvedValue(undefined);
  insertSalePaymentMock.mockImplementation(async (_sql, input) =>
    paymentRow({ ...input, id: PAYMENT, createdAt: CREATED_AT, updatedAt: CREATED_AT })
  );

  findSaleByIdMock.mockImplementation(async (_sql, _pharmacyId, id) => (id === SALE ? stored : null));
  findSaleByClientSaleIdMock.mockResolvedValue(null);
  listSaleItemsMock.mockResolvedValue([saleItem()]);
  listSaleItemBatchesMock.mockResolvedValue([
    { ...saleItemBatch(), inventoryId: PRODUCT } as SaleItemBatchRow & { inventoryId: string },
  ]);
  listSalePaymentsMock.mockResolvedValue([paymentRow()]);
  querySalesMock.mockResolvedValue([]);
  lockSaleMock.mockImplementation(async (_sql, _pharmacyId, id) => (id === SALE ? stored : null));
  markSaleVoidedMock.mockImplementation(async (_sql, saleId, input) => {
    if (saleId !== SALE || stored.status === 'voided') return null;
    stored = {
      ...stored,
      status: 'voided',
      voidReason: input.reason,
      voidedAt: input.voidedAt,
      // Zeroed in the same statement as the status, and not by a later call to
      // `updateSaleSettlement`: the receipt of a voided sale must not keep a
      // figure the drawer no longer holds, and there is no window in which it
      // does.
      amountPaid: '0.00',
      changeGiven: '0.00',
    };
    return stored;
  });
  updateSaleSettlementMock.mockImplementation(async (_sql, saleId, input) => {
    // The same `status <> 'voided'` guard the statement carries. Money arriving
    // against a voided sale is handled by the caller, not by this update.
    if (saleId !== SALE || stored.status === 'voided') return null;
    stored = { ...stored, ...input };
    return stored;
  });
  findSalePaymentMock.mockResolvedValue(
    lockedPayment({
      method: 'momo',
      status: 'pending',
      reference: `${SALE_NUMBER}-ABCDEF0123456789`,
      paidAt: null,
    })
  );
  updateSalePaymentStatusMock.mockResolvedValue(paymentRow());
  patientExistsMock.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

describe('the authorisation matrix', () => {
  for (const route of ROUTE_TABLE) {
    it(`${route.method.toUpperCase()} ${route.path} needs ${route.permission}`, async () => {
      const violations: string[] = [];

      for (const [role, token] of ROLES) {
        // No body on purpose. `authorize` runs before validation, so a 400 for a
        // permitted role is proof authorisation passed — and sending a valid body
        // would make every row of this matrix depend on every route's fixtures,
        // which is a test that fails for reasons that are not about permission.
        const response = await send(route.method, route.path, token());
        const denied = (DENIED[route.name] ?? []).includes(role);

        if (denied) {
          if (response.status !== 403) {
            violations.push(
              `${route.name}: ${role} answered ${response.status} without holding ${route.permission}`
            );
            continue;
          }
          // `authorize` sends `details: { missing: [...] }` — an object holding
          // an array, not the array itself. Naming the permission is what lets
          // the till say who to ask instead of showing a bare refusal, so a 403
          // without it is a violation and not a passing row.
          const body = errorOf(response.body);
          const details = body.error.details;
          const missing =
            body.error.code === 'forbidden' && typeof details === 'object' && details !== null
              ? (details as { missing?: unknown }).missing
              : undefined;
          if (!Array.isArray(missing)) {
            violations.push(`${route.name}: ${role} was refused without naming the permission`);
            continue;
          }
          if (missing.join() !== route.permission) {
            violations.push(
              `${route.name}: ${role} was refused for ${JSON.stringify(missing)}, not ${route.permission}`
            );
          }
        } else if (response.status === 403) {
          violations.push(
            `${route.name}: ${role} was refused despite holding ${route.permission}`
          );
        }
      }

      expect(violations).toEqual([]);
    });
  }

  it('does no work at all for a role that may not do it', async () => {
    // The owner-only void is the one that matters: a cashier who could void
    // could put stock back on the shelf and take a sale out of the takings in
    // one action, which is the shape of a leak no report ever shows.
    const response = await send('post', `/sales/${SALE}/void`, tokenFor(CASHIER_ID, 'staff'), {
      reason: 'Customer changed their mind',
    });
    expect(response.status).toBe(403);
    expect(markSaleVoidedMock).not.toHaveBeenCalled();
    expect(lockSaleMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('answers 401 with no token, on every route', async () => {
    const violations: string[] = [];
    for (const route of ROUTE_TABLE) {
      const response = await send(route.method, route.path, undefined);
      if (response.status !== 401) {
        violations.push(`${route.name} answered ${response.status}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Route order
// ---------------------------------------------------------------------------

describe('route order', () => {
  it('answers /sales/products from the literal path, not from /:id', async () => {
    const response = await send('get', '/sales/products', tokenFor(OWNER_ID, 'pharmacy_owner'));
    // Declared second, this arrives at `GET /sales/:id` with `id = "products"`
    // and answers a 400 from the UUID validator — a well-formed request refused
    // by a route that was never meant to see it.
    expect(response.status).toBe(200);
    expect(queryProductsMock).toHaveBeenCalled();
    expect(findSaleByIdMock).not.toHaveBeenCalled();
  });

  it.each([
    '/sales/categories',
    '/sales/payment-config',
    '/sales/approvers',
  ])('answers %s from its literal path', async (path) => {
    const response = await send('get', path, tokenFor(OWNER_ID, 'pharmacy_owner'));
    expect(response.status).toBe(200);
  });

  it('reaches the verify route before /:id swallows "payments"', async () => {
    const response = await send(
      'post',
      `/sales/payments/${PAYMENT}/verify`,
      tokenFor(OWNER_ID, 'pharmacy_owner')
    );
    // A 404 here would mean `/:id` matched first with `id = "payments"`.
    expect(response.status).not.toBe(404);
    expect(findSaleByIdMock).not.toHaveBeenCalled();
  });

  it('refuses a sale id that is not a UUID rather than querying with it', async () => {
    const response = await send('get', '/sales/products', tokenFor(OWNER_ID, 'pharmacy_owner'));
    expect(response.status).toBe(200);
    const bad = await send('get', '/sales/not-a-uuid', tokenFor(OWNER_ID, 'pharmacy_owner'));
    expect(bad.status).toBe(400);
    expect(errorOf(bad.body).error.code).toBe('validation_failed');
    expect(findSaleByIdMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What the till loads
// ---------------------------------------------------------------------------

describe('GET /sales/products', () => {
  it('never offers an inactive product, whatever the query says', async () => {
    // `includeInactive` is not a filter on this route. An inactive product is
    // one the write path refuses with `product_inactive`, so a grid that could
    // ask for them would show a tile the operator can press and a basket that
    // will not complete.
    await send(
      'get',
      '/sales/products?includeInactive=true',
      tokenFor(CASHIER_ID, 'staff')
    );
    expect(queryProductsMock).toHaveBeenCalledWith(
      expect.anything(),
      PHARMACY,
      expect.objectContaining({ includeInactive: false })
    );
  });

  it('passes the search and category through, and omits them when empty', async () => {
    await send('get', '/sales/products?search=para&category=Analgesic', tokenFor(CASHIER_ID, 'staff'));
    expect(queryProductsMock).toHaveBeenLastCalledWith(
      expect.anything(),
      PHARMACY,
      expect.objectContaining({ search: 'para', category: 'Analgesic' })
    );

    await send('get', '/sales/products?search=&category=', tokenFor(CASHIER_ID, 'staff'));
    // Asserted rather than assumed: without it the two `in` checks below would
    // pass on a route that never reached the repository at all, which is the
    // one way this test could go green while the behaviour it guards is gone.
    expect(queryProductsMock).toHaveBeenCalledTimes(2);
    const filters = queryProductsMock.mock.calls[1]?.[2] as unknown as Record<string, unknown>;
    // Omitted rather than sent as `''`: a repository that received an empty
    // search would be one `!== ''` check away from filtering everything out.
    expect('search' in filters).toBe(false);
    expect('category' in filters).toBe(false);
  });

  it('refuses a limit above the ceiling instead of reading the whole catalogue', async () => {
    const response = await send('get', '/sales/products?limit=5000', tokenFor(CASHIER_ID, 'staff'));
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'limit', message: 'limit must be between 1 and 200' },
    ]);
    expect(queryProductsMock).not.toHaveBeenCalled();
  });
});

describe('GET /sales/payment-config', () => {
  it('reports the gateway as unconfigured rather than inventing a key', async () => {
    // `jest.setup.js` deletes both Paystack variables outright, so this is the
    // state a deployment with no keys is in — and the honest answer is
    // `configured: false` with `mode: 'unconfigured'`, which is what makes the
    // till record mobile money manually and say so instead of handing a customer
    // a prompt that cannot complete.
    const response = await send('get', '/sales/payment-config', tokenFor(CASHIER_ID, 'staff'));
    expect(response.status).toBe(200);
    expect(response.body.data.paymentConfig).toEqual({
      publicKey: '',
      configured: false,
      mode: 'unconfigured',
      methods: ['cash', 'momo'],
      currency: 'GHS',
    });
  });
});

describe('GET /sales/approvers', () => {
  it('offers only people who may actually approve a prescription sale', async () => {
    listStaffMock.mockResolvedValue([
      userRow(OWNER_ID, 'pharmacy_owner'),
      userRow(PHARMACIST_ID, 'pharmacist'),
      userRow(CASHIER_ID, 'staff'),
      userRow('a0000000-0000-4000-8000-000000000005', 'pharmacist', { isActive: false }),
    ]);

    const response = await send('get', '/sales/approvers', tokenFor(CASHIER_ID, 'staff'));
    expect(response.status).toBe(200);
    // The cashier is absent because a role that can both sell and approve its own
    // prescription sale is a control gap; the deactivated pharmacist is absent
    // because a picker that offered them would produce a sale the write path then
    // refuses.
    expect(response.body.data.approvers.map((a: { id: string }) => a.id)).toEqual([
      OWNER_ID,
      PHARMACIST_ID,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Quote: write-free
// ---------------------------------------------------------------------------

describe('POST /sales/quote', () => {
  it('prices the basket and writes nothing at all', async () => {
    const response = await send('post', '/sales/quote', tokenFor(CASHIER_ID, 'staff'), BASKET);

    expect(response.status).toBe(200);
    expect(response.body.data.basket.total).toBe('25.00');
    expect(response.body.data.canFulfil).toBe(true);
    // The guarantee BRIEF.md's landmine 9 depends on: a quote is how a
    // disagreement between the till's own pricer and the server's gets diagnosed
    // in production, and a diagnostic endpoint that can write is one that can
    // make things worse while somebody is trying to find out what is wrong.
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(insertSaleMock).not.toHaveBeenCalled();
    expect(insertSalePaymentMock).not.toHaveBeenCalled();
    expect(setBatchQuantityMock).not.toHaveBeenCalled();
    expect(nextSaleNumberMock).not.toHaveBeenCalled();
    // And it takes no locks: two tills quoting the same product must not
    // serialise, and a quote must not be able to block a sale.
    expect(lockProductMock).not.toHaveBeenCalled();
  });

  it('reports a shortfall as an answer, not as a refusal', async () => {
    listBatchesForProductMock.mockResolvedValue([]);
    const response = await send(
      'post',
      '/sales/quote',
      tokenFor(CASHIER_ID, 'staff'),
      { lines: [{ productId: PRODUCT, quantity: 2 }] }
    );
    // `quoteSale` reads products without locking and reports `shortfall` per
    // line. A 409 here would be indistinguishable from the one `POST /sales`
    // gives, which is the signal Phase 9's queue reads as "retry later" — and a
    // quote is not something to retry.
    expect(response.status).toBe(200);
    expect(response.body.data.canFulfil).toBe(false);
    expect(response.body.data.lines[0].shortfall).toBe(2);
  });

  it('refuses an empty basket in the words the form can show', async () => {
    const response = await send('post', '/sales/quote', tokenFor(CASHIER_ID, 'staff'), { lines: [] });
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'lines', message: 'A basket needs between 1 and 100 items' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('POST /sales', () => {
  const CASH_BODY = { ...BASKET, payments: [{ method: 'cash', amount: '25.00' }], clientSaleId: CLIENT_SALE_ID };

  it('records the sale and answers 201 with the receipt', async () => {
    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), CASH_BODY);

    expect(response.status).toBe(201);
    expect(response.body.data.replayed).toBe(false);
    expect(response.body.data.detail.sale.saleNumber).toBe(SALE_NUMBER);
    expect(response.body.data.detail.sale.total).toBe('25.00');
    // Cash is settled the moment it is recorded, because the note is in the
    // drawer or it is not and no third party will ever say otherwise.
    expect(response.body.data.detail.sale.status).toBe('completed');
  });

  it('reads the clock once, so today and now cannot straddle midnight apart', async () => {
    await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), CASH_BODY);

    const today = todayDateOnlyMock.mock.calls[0]?.[0];
    const now = nowIsoMock.mock.calls[0]?.[0];
    expect(today).toBeInstanceOf(Date);
    // Identity, not equality. Two `new Date()` calls a microsecond apart are
    // `===`-distinct objects even when they format to the same millisecond, so
    // this is the assertion that catches a request starting at 23:59:59.999 and
    // being FEFO-judged against yesterday while timestamped today.
    expect(now).toBe(today);
  });

  it('mints the mobile money reference itself and throws the caller\'s away', async () => {
    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), {
      ...BASKET,
      payments: [{ method: 'momo', amount: '25.00', reference: 'chosen-by-the-caller' }],
    });

    expect(response.status).toBe(201);

    const written = insertSalePaymentMock.mock.calls[0]?.[1];
    expect(written).toBeDefined();
    // The whole premise of the webhook path. A webhook arrives carrying a
    // reference and no tenant, so `findSalePaymentByReference` has to answer with
    // exactly one row — which holds only if the reference was chosen here, once,
    // by nobody else. A caller who could pick its own could make two tenders
    // share one, and the lookup takes the earliest match: one charge would
    // settle the other's tender and both would look correct on the receipt.
    expect(written?.reference).not.toBe('chosen-by-the-caller');
    expect(written?.reference).toMatch(new RegExp(`^${SALE_NUMBER}-[0-9A-F]{16}$`));
    // Written `pending` and dated null: a `paid_at` on a tender that has not
    // arrived is a receipt claiming money nobody has seen.
    expect(written?.status).toBe('pending');
    expect(written?.paidAt).toBeNull();
    expect(response.body.data.detail.sale.status).toBe('pending');
  });

  it('gives two mobile money tenders two different references', async () => {
    // Not a case the settlement rule allows to complete, but a case the write
    // path can reach: a first tender that failed and a second taken afterwards.
    // Two rows sharing a reference is the failure the unique index in migration
    // 0003 exists to make loud rather than silent.
    await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), {
      ...BASKET,
      payments: [
        { method: 'momo', amount: '10.00' },
        { method: 'momo', amount: '15.00' },
      ],
    });

    const first = insertSalePaymentMock.mock.calls[0]?.[1]?.reference;
    const second = insertSalePaymentMock.mock.calls[1]?.[1]?.reference;
    // The whole reference, not its random half. `findSalePaymentByReference`
    // looks the tender up by the complete string, so a reference that had lost
    // the sale number would be a webhook that never finds its tender — and a
    // pattern matching only the suffix would not see it go.
    const shape = new RegExp(`^${SALE_NUMBER}-[0-9A-F]{16}$`);
    expect(first).toMatch(shape);
    expect(second).toMatch(shape);
    expect(first).not.toBe(second);
  });

  it('keeps the operator\'s note on a cash tender, where the column is a note', async () => {
    await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), {
      ...BASKET,
      payments: [{ method: 'cash', amount: '25.00', reference: 'GHS 50 note, GHS 25 back' }],
    });

    // On a cash tender `reference` is not a gateway binding at all: it is the
    // free text the drawer reconciliation needs. Discarding it would throw away
    // the one thing the column is for, and the lookup that finds a webhook's
    // tender is restricted to `method = 'momo'` precisely so this text can never
    // be mistaken for one.
    expect(insertSalePaymentMock.mock.calls[0]?.[1]?.reference).toBe('GHS 50 note, GHS 25 back');
    expect(insertSalePaymentMock.mock.calls[0]?.[1]?.status).toBe('succeeded');
    expect(insertSalePaymentMock.mock.calls[0]?.[1]?.paidAt).not.toBeNull();
  });

  it('refuses a tender method that is not in the enum, at the route', async () => {
    // Landmine 1 seen from the wire. `card` was removed from the tender list
    // before the schema was written, so it is not a member of
    // `sale_payment_method` and an uncast comparison against it is a Postgres
    // parse failure — a bare 500 on every sale, looking exactly like a gateway
    // outage. The route turns it into a sentence before it can reach one.
    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), {
      ...BASKET,
      payments: [{ method: 'card', amount: '25.00' }],
    });
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'payments[0].method', message: 'Payment method must be one of cash, momo' },
    ]);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses more tenders than the array ceiling, before reading any of them', async () => {
    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), {
      ...BASKET,
      payments: Array.from({ length: 5 }, () => ({ method: 'cash', amount: '5.00' })),
    });
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'payments', message: 'A sale takes at most 4 payments' },
    ]);
  });

  it('answers 200 and hands back the stored sale when the clientSaleId was already recorded', async () => {
    findSaleByClientSaleIdMock.mockResolvedValue(saleRow());

    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), CASH_BODY);

    // 200 and not 409: the till lost the response to a sale that went through,
    // and the answer to "did that sale record?" is the sale. A 409 would leave
    // the operator staring at a refusal for money already in the drawer.
    expect(response.status).toBe(200);
    expect(response.body.data.replayed).toBe(true);
    // Nothing was written on the replay, and in particular no second receipt
    // number was taken — the advisory lock in `nextSaleNumber` is pharmacy-wide,
    // so a replay that took one would be a gap in the sequence for no reason.
    expect(insertSaleMock).not.toHaveBeenCalled();
    expect(nextSaleNumberMock).not.toHaveBeenCalled();
    expect(setBatchQuantityMock).not.toHaveBeenCalled();
  });

  it('surfaces a short drawer as 409, which is the signal the offline queue retries on', async () => {
    listBatchesForProductMock.mockResolvedValue([batch({ quantity: 1 })]);

    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), CASH_BODY);

    // 409 and not 400. The request is well formed and the drawer is short, and
    // the distinction is functional rather than pedantic: Phase 9's queue must
    // not retry a 400 (the basket needs a person) and should retry a 409 (stock
    // may be received, or another till may void).
    expect(response.status).toBe(409);
    expect(errorOf(response.body).error.code).toBe('insufficient_stock');
    expect(insertSaleMock).not.toHaveBeenCalled();
  });

  it('names the products that need an approver rather than refusing in the abstract', async () => {
    lockProductMock.mockResolvedValue(product({ requiresPrescription: true }));

    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), CASH_BODY);

    expect(response.status).toBe(400);
    const body = errorOf(response.body);
    expect(body.error.code).toBe('prescription_needs_approver');
    expect(body.error.message).toContain('Paracetamol 500mg');
    expect(body.error.details).toEqual({ products: [PRODUCT] });
    expect(insertSaleMock).not.toHaveBeenCalled();
  });

  it('accepts an approver the picker offered and records who approved', async () => {
    lockProductMock.mockResolvedValue(product({ requiresPrescription: true }));

    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), {
      ...CASH_BODY,
      approvedBy: PHARMACIST_ID,
    });

    expect(response.status).toBe(201);
    expect(insertSaleMock).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ approvedBy: PHARMACIST_ID, servedBy: CASHIER_ID })
    );
    expect(response.body.data.detail.approvedByName).toBe('pharmacist');
  });

  it('refuses an approver who may not approve, even though the id is a real person', async () => {
    lockProductMock.mockResolvedValue(product({ requiresPrescription: true }));

    // A second cashier. Naming a colleague who cannot approve is the mistake the
    // picker exists to prevent, and the write path has to refuse it anyway:
    // hiding a button is not authorisation.
    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), {
      ...CASH_BODY,
      approvedBy: 'a0000000-0000-4000-8000-000000000009',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(insertSaleMock).not.toHaveBeenCalled();
  });

  it('refuses a clientSaleId short enough for two tills to reach the same one', async () => {
    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), {
      ...BASKET,
      payments: [{ method: 'cash', amount: '25.00' }],
      clientSaleId: '1',
    });
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.code).toBe('validation_failed');
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// History and detail
// ---------------------------------------------------------------------------

describe('GET /sales', () => {
  it('passes the filters through as the repository reads them', async () => {
    await send(
      'get',
      '/sales?status=voided&from=2026-09-01&to=2026-09-04&servedBy=' + OWNER_ID + '&search=H3-&limit=10&offset=20',
      tokenFor(OWNER_ID, 'pharmacy_owner')
    );

    expect(querySalesMock).toHaveBeenCalledWith(expect.anything(), PHARMACY, {
      status: 'voided',
      from: '2026-09-01',
      to: '2026-09-04',
      servedBy: OWNER_ID,
      search: 'H3-',
      limit: 10,
      offset: 20,
    });
  });

  it('omits every filter that was not sent, rather than sending nulls to guess at', async () => {
    await send('get', '/sales', tokenFor(CASHIER_ID, 'staff'));
    expect(querySalesMock).toHaveBeenCalledWith(expect.anything(), PHARMACY, {
      status: null,
      from: null,
      to: null,
      servedBy: null,
      search: null,
      limit: 50,
      offset: 0,
    });
  });

  it('treats a cleared filter cell as a filter that was not sent', async () => {
    await send(
      'get',
      '/sales?status=&from=&to=&servedBy=&search=',
      tokenFor(CASHIER_ID, 'staff')
    );

    // The same answer as the request above, and that agreement is the assertion.
    // Resetting the date picker and the staff dropdown produces `?from=&servedBy=`,
    // and `.isDate()` and `.isUUID()` both refuse an empty string unless the chain
    // says `{ values: 'falsy' }`. So before `routes/shared.ts`'s `OPTIONAL_QUERY`
    // this request was four 400s while the `?search=` beside it was accepted — two
    // answers on one query string, which is invisible from either chain on its own.
    // The refusals are still there for a value that is not empty and not valid, and
    // the next two tests are what proves the widening did not simply remove them.
    expect(querySalesMock).toHaveBeenCalledWith(expect.anything(), PHARMACY, {
      status: null,
      from: null,
      to: null,
      servedBy: null,
      search: null,
      limit: 50,
      offset: 0,
    });
  });

  it('refuses a status that is not a member of the enum', async () => {
    // `refunded` and `partially_refunded` are members nothing writes yet; `owed`
    // is not a member at all, and reaching the repository would be a value going
    // into a `::sale_status` comparison — the one place in this codebase where
    // being wrong is a 500 on every request rather than a message.
    const response = await send('get', '/sales?status=owed', tokenFor(OWNER_ID, 'pharmacy_owner'));
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'status',
        message: 'Status must be one of pending, completed, voided, refunded, partially_refunded',
      },
    ]);
    expect(querySalesMock).not.toHaveBeenCalled();
  });

  it('refuses a date that is not YYYY-MM-DD', async () => {
    const response = await send('get', '/sales?from=04/09/2026', tokenFor(OWNER_ID, 'pharmacy_owner'));
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      { field: 'from', message: 'Enter the start date as YYYY-MM-DD' },
    ]);
  });
});

describe('GET /sales/:id', () => {
  it('answers with the sale, its lines, its lots, its tenders and both names', async () => {
    const response = await send('get', `/sales/${SALE}`, tokenFor(CASHIER_ID, 'staff'));

    expect(response.status).toBe(200);
    const detail = response.body.data as {
      sale: SaleRow;
      items: SaleItemRow[];
      batches: Array<SaleItemBatchRow & { inventoryId: string }>;
      payments: SalePaymentRow[];
      servedByName: string;
      approvedByName: string | null;
    };
    // The lots are in the response because they are what makes "which lot did
    // that customer get" answerable at a counter without a database — and what
    // makes a recall traceable to the person who was handed the stock.
    expect(detail.batches[0]?.lotNumber).toBe('LOT-1');
    expect(detail.batches[0]?.inventoryId).toBe(PRODUCT);
    expect(detail.servedByName).toBe('Beatrice Owusu');
    expect(detail.approvedByName).toBeNull();
  });

  it('reports a sale belonging to another pharmacy as not found', async () => {
    findSaleByIdMock.mockResolvedValue(null);
    const response = await send('get', `/sales/${SALE}`, tokenFor(OWNER_ID, 'pharmacy_owner'));
    // One message for "not there" and "not yours". Telling a caller which of the
    // two they got hands them a way to enumerate ids in other tenants.
    expect(response.status).toBe(404);
    expect(errorOf(response.body).error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Payments after the fact
// ---------------------------------------------------------------------------

describe('POST /sales/:id/payments', () => {
  it('adds a tender to an open sale and answers 201', async () => {
    stored = saleRow(OPEN_SALE);
    // The read inside the transaction sees no tenders yet; the read-back after
    // the insert sees the one just written, which the suite-wide default
    // already describes — a succeeded cash tender for the full total. One
    // static list cannot be both, and a list that held this tender from the
    // start would make the sale overpaid before the request arrived. That is
    // the case tested two below, not this one.
    listSalePaymentsMock.mockResolvedValueOnce([]);

    const response = await send(
      'post',
      `/sales/${SALE}/payments`,
      tokenFor(CASHIER_ID, 'staff'),
      { method: 'cash', amount: '25.00' }
    );
    expect(response.status).toBe(201);
    expect(insertSalePaymentMock).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ saleId: SALE, method: 'cash', status: 'succeeded' })
    );
    // The settlement is recomputed from every tender the sale now has, not
    // incremented: a webhook and an operator taking cash for the same sale
    // interleave, and an increment is how one of them gets counted twice.
    expect(updateSaleSettlementMock).toHaveBeenCalledWith(CLIENT, SALE, {
      amountPaid: '25.00',
      changeGiven: '0.00',
      status: 'completed',
    });
    // And the receipt handed back agrees with the row, which is the part a
    // static read-back fixture would have been unable to show either way.
    expect(response.body.data.sale.status).toBe('completed');
    expect(response.body.data.payments).toHaveLength(1);
  });

  it('refuses a sale that has been voided with 409, not 400', async () => {
    stored = saleRow({
      status: 'voided',
      voidedAt: CREATED_AT,
      voidReason: 'Customer walked out without paying',
    });
    const response = await send(
      'post',
      `/sales/${SALE}/payments`,
      tokenFor(CASHIER_ID, 'staff'),
      { method: 'cash', amount: '25.00' }
    );
    // The request was well formed and the sale has moved on. A 400 would say
    // "you sent the wrong thing", which would strand a payment that simply
    // arrived late in Phase 9's queue.
    expect(response.status).toBe(409);
    expect(errorOf(response.body).error.code).toBe('sale_voided');
    expect(insertSalePaymentMock).not.toHaveBeenCalled();
  });

  it('refuses a tender that would overpay with change it is not allowed to give', async () => {
    stored = saleRow(OPEN_SALE);
    // Nothing taken yet, so the refusal is about this tender alone and not
    // about a sale that was already paid before the request arrived.
    listSalePaymentsMock.mockResolvedValue([]);

    const response = await send(
      'post',
      `/sales/${SALE}/payments`,
      tokenFor(CASHIER_ID, 'staff'),
      // Mobile money cannot give change: there is nobody at the counter to hand
      // it back, and a wallet is not a drawer.
      { method: 'momo', amount: '30.00' }
    );
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.code).toBe('payment_refused');
    expect(insertSalePaymentMock).not.toHaveBeenCalled();
  });
});

describe('POST /sales/payments/:paymentId/verify', () => {
  // `jest.setup.js` deletes both Paystack variables, so `callGateway` throws
  // `gateway_unconfigured` before it ever reaches `fetch`. Stubbing `fetch`
  // here would be a stub nothing can call, and a reader would take it for a
  // claim that the happy path is covered. It is not: the configured-gateway
  // behaviour of this route is `webhooks.routes.test.ts` and
  // `paystack.service.test.ts`, which rebuild `config` through `buildConfig`.
  // What is asserted here is the refusal.
  it('refuses while the gateway is unconfigured, rather than silently succeeding', async () => {
    const response = await send(
      'post',
      `/sales/payments/${PAYMENT}/verify`,
      tokenFor(OWNER_ID, 'pharmacy_owner')
    );
    // 503 and not 500: the till has to be able to tell "this server cannot ask"
    // from "something broke", because the first is a configuration the owner can
    // fix and the second is an outage.
    expect(response.status).toBe(503);
    expect(errorOf(response.body).error.code).toBe('gateway_unconfigured');
    expect(updateSalePaymentStatusMock).not.toHaveBeenCalled();
  });

  it('refuses to verify a cash tender, which was settled when it was taken', async () => {
    findSalePaymentMock.mockResolvedValue(lockedPayment({ method: 'cash', status: 'succeeded' }));
    const response = await send(
      'post',
      `/sales/payments/${PAYMENT}/verify`,
      tokenFor(OWNER_ID, 'pharmacy_owner')
    );
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.code).toBe('payment_not_gateway');
  });
});

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

describe('POST /sales/:id/void', () => {
  it('restores the stock to the batches each line drew from, and answers with the sale', async () => {
    listSaleItemBatchesMock.mockResolvedValue([
      { ...saleItemBatch(), inventoryId: PRODUCT, batchId: BATCH, quantity: 2 },
    ]);

    const response = await send('post', `/sales/${SALE}/void`, tokenFor(OWNER_ID, 'pharmacy_owner'), {
      reason: 'Customer walked out without paying',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.sale.status).toBe('voided');
    // To the batch, by id, through the junction row — never to
    // `inventory.quantity`. Adding units to the product row would be undone by
    // `touch_inventory_after_batch_change` the next time any batch is written,
    // and adding them to the wrong batch would hand the next customer a lot that
    // is not on the shelf.
    expect(setBatchQuantityMock).toHaveBeenCalledWith(CLIENT, BATCH, 102);
    expect(markSaleVoidedMock).toHaveBeenCalledWith(
      CLIENT,
      SALE,
      expect.objectContaining({ reason: 'Customer walked out without paying' })
    );
  });

  it('refuses a reason too short to distinguish a mistake from a theft', async () => {
    const response = await send('post', `/sales/${SALE}/void`, tokenFor(OWNER_ID, 'pharmacy_owner'), {
      reason: 'x',
    });
    expect(response.status).toBe(400);
    expect(errorOf(response.body).error.details).toEqual([
      {
        field: 'reason',
        message:
          'Enter why this sale is being voided — at least 3 characters, because this is the audit trail',
      },
    ]);
    expect(markSaleVoidedMock).not.toHaveBeenCalled();
  });

  it('refuses a second void with 409, so stock is never restored twice', async () => {
    markSaleVoidedMock.mockResolvedValue(null);
    const response = await send('post', `/sales/${SALE}/void`, tokenFor(OWNER_ID, 'pharmacy_owner'), {
      reason: 'Customer walked out without paying',
    });
    // Two owners clicking void at the same instant both pass the status read;
    // only one gets a row back from the guarded update. Restoring the same stock
    // twice is a failure no report shows — the drawer is simply heavier than the
    // ledger thinks.
    expect(response.status).toBe(409);
    expect(errorOf(response.body).error.code).toBe('sale_already_voided');
    expect(setBatchQuantityMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Faults from below
// ---------------------------------------------------------------------------

describe('a fault from the write path', () => {
  it('reaches the browser as the status the service chose, not as a 500', async () => {
    insertSaleMock.mockRejectedValue(
      new HttpError(409, 'That sale has already been recorded', { code: 'sale_already_recorded' })
    );
    // With no `clientSaleId` the replay path cannot rescue it, so the 409 is what
    // the caller sees. A service fault arriving as a 500 would be indistinguishable
    // from an outage — and BRIEF.md's landmine 3 is that a 500 is not an offline
    // signal, so the queue would retry a refusal forever.
    const response = await send('post', '/sales', tokenFor(CASHIER_ID, 'staff'), {
      ...BASKET,
      payments: [{ method: 'cash', amount: '25.00' }],
    });
    expect(response.status).toBe(409);
    expect(errorOf(response.body).error.code).toBe('sale_already_recorded');
  });

  it('withholds the message of a fault that is not an HttpError', async () => {
    querySalesMock.mockRejectedValue(new Error('relation "sales" does not exist'));
    const response = await send('get', '/sales', tokenFor(OWNER_ID, 'pharmacy_owner'));
    expect(response.status).toBe(500);
    // `NODE_ENV` is `test` rather than `production`, so the message is shown —
    // which is the point of asserting the code instead: the shape is stable and
    // the text is not, and a till that branched on the text would break on the
    // day the wording improved.
    expect(errorOf(response.body).error.code).toBe('internal_error');
  });
});
