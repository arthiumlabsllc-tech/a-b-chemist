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
  listMovements: jest.fn(),
  listProducts: jest.fn(),
  lockProduct: jest.fn(),
  mergeIntoBatch: jest.fn(),
  recallTrace: jest.fn(),
  setBatchQuantity: jest.fn(),
  updateProduct: jest.fn(),
}));

jest.mock('../repositories/notifications.repository', () => ({
  raiseNotification: jest.fn(),
  listNotifications: jest.fn(),
}));

import request from 'supertest';
import { createApp } from '../app';
import { withSavepoint, withTransaction } from '../database/pool';
import {
  createProduct as insertProduct,
  findBatch,
  findBatchByLot,
  findProductByCode,
  findProductById,
  insertBatch,
  insertMovement,
  listActiveProducts,
  listBatchesForProduct,
  listBatchesHoldingStock,
  listMovements as queryMovements,
  listProducts as queryProducts,
  lockProduct,
  mergeIntoBatch,
  recallTrace,
  setBatchQuantity,
  updateProduct as applyProductPatch,
  type BatchRow,
  type MovementRow,
  type ProductRow,
  type RecallSaleRow,
} from '../repositories/inventory.repository';
import { listNotifications } from '../repositories/notifications.repository';
import { findUserById, type UserRow } from '../repositories/users.repository';
import { KNOWN_IMPORT_COLUMNS } from '../services/inventory-import.service';
import { DERIVED_PRODUCT_FIELDS } from '../services/inventory.service';
import { signAccessToken } from '../utils/jwt';
import type { Permission, UserRole } from '../utils/permissions';

/**
 * Inventory, over HTTP.
 *
 * The repositories and the pool are mocked. **The services are not**, and that
 * is the point: three of the guarantees this phase owes are only visible at the
 * boundary, and mocking the service would move every one of them out of reach.
 *
 * - The four derived product columns cannot be written *through the API*. The
 *   route forwards `req.body` as it arrived; the stripping happens in the
 *   service. A suite that mocked the service would be asserting that the route
 *   forwards a body, which is true and worthless.
 * - A `received_at` in the future is refused. `express-validator` checks the
 *   *format*; the rule that it cannot be later than now lives in the service.
 * - Route order. Express matches in declaration order, so `GET /inventory/alerts`
 *   reaches `/:id` with `id = "alerts"` if the literal path is declared second.
 *   Nothing below the router can detect that.
 *
 * What is mocked is the SQL, and that the SQL is valid is
 * `inventory.repository.test.ts` and the harness in `database/tests`.
 */

const app = createApp();

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const STAFF_ID = 'a0000000-0000-4000-8000-000000000004';
const PRODUCT = 'a0000000-0000-4000-8000-000000000010';
const BATCH = 'a0000000-0000-4000-8000-000000000020';
const SALE = 'a0000000-0000-4000-8000-000000000030';

const CLIENT = { query: jest.fn() };

/**
 * Far enough ahead that this suite does not start failing on a date.
 *
 * The routes compute today from the real clock — deliberately, so the alert scan
 * stays testable against a date in the past — so an expiry a few months ahead
 * would quietly become an expired lot and change what `sellable` reports.
 */
const FUTURE = '2099-12-31';

const withTransactionMock = jest.mocked(withTransaction);
const withSavepointMock = jest.mocked(withSavepoint);
const insertProductMock = jest.mocked(insertProduct);
const applyProductPatchMock = jest.mocked(applyProductPatch);
const findProductByIdMock = jest.mocked(findProductById);
const findProductByCodeMock = jest.mocked(findProductByCode);
const queryProductsMock = jest.mocked(queryProducts);
const lockProductMock = jest.mocked(lockProduct);
const listBatchesForProductMock = jest.mocked(listBatchesForProduct);
const listActiveProductsMock = jest.mocked(listActiveProducts);
const listBatchesHoldingStockMock = jest.mocked(listBatchesHoldingStock);
const findBatchMock = jest.mocked(findBatch);
const findBatchByLotMock = jest.mocked(findBatchByLot);
const insertBatchMock = jest.mocked(insertBatch);
const mergeIntoBatchMock = jest.mocked(mergeIntoBatch);
const setBatchQuantityMock = jest.mocked(setBatchQuantity);
const insertMovementMock = jest.mocked(insertMovement);
const queryMovementsMock = jest.mocked(queryMovements);
const recallTraceMock = jest.mocked(recallTrace);
const listNotificationsMock = jest.mocked(listNotifications);
const findUserByIdMock = jest.mocked(findUserById);

function userRow(id: string, role: UserRole, overrides: Partial<UserRow> = {}): UserRow {
  return {
    id,
    pharmacyId: PHARMACY,
    fullName: 'Unnamed',
    email: `${id}@aandb.example`,
    phone: null,
    role,
    passwordHash: '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS',
    isActive: true,
    // Matches the token below. `authenticate` rejects a token whose version is
    // behind the row, which is how a forced logout works.
    sessionVersion: 2,
    lastLoginAt: null,
    ...overrides,
  };
}

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
    performedBy: OWNER_ID,
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
    servedBy: OWNER_ID,
    patientName: 'Ama Mensah',
    patientPhone: '+233201234567',
    ...overrides,
  };
}

function tokenFor(id: string, role: UserRole): string {
  return signAccessToken({ userId: id, pharmacyId: PHARMACY, role, sessionVersion: 2 });
}

const ownerToken = (): string => tokenFor(OWNER_ID, 'pharmacy_owner');
const pharmacistToken = (): string => tokenFor(PHARMACIST_ID, 'pharmacist');
const staffToken = (): string => tokenFor(STAFF_ID, 'staff');

const TOKENS: Record<UserRole, () => string> = {
  pharmacy_owner: ownerToken,
  pharmacist: pharmacistToken,
  staff: staffToken,
};

/** An authenticated request. The body is added at the call site, if there is one. */
function call(method: 'get' | 'post' | 'patch', path: string, token: string): request.Test {
  const agent = request(app);
  const test =
    method === 'get' ? agent.get(path) : method === 'post' ? agent.post(path) : agent.patch(path);
  return test.set('Authorization', `Bearer ${token}`);
}

/**
 * Every route on this router, with the permission it declares.
 *
 * Written out by hand rather than read from the router, on purpose. A table read
 * from the source would agree with the source by construction and could not
 * notice a route that declared the wrong permission — which is the failure this
 * table exists to catch.
 */
const ROUTE_TABLE: { method: 'get' | 'post' | 'patch'; path: string; permission: Permission }[] = [
  { method: 'get', path: '/inventory/alerts', permission: 'notifications:read' },
  { method: 'post', path: '/inventory/alerts/scan', permission: 'inventory:alerts:scan' },
  { method: 'get', path: '/inventory/import/template', permission: 'inventory:import' },
  { method: 'post', path: '/inventory/import', permission: 'inventory:import' },
  { method: 'get', path: '/inventory', permission: 'inventory:read' },
  { method: 'post', path: '/inventory', permission: 'inventory:product:write' },
  { method: 'get', path: `/inventory/${PRODUCT}`, permission: 'inventory:read' },
  { method: 'patch', path: `/inventory/${PRODUCT}`, permission: 'inventory:product:write' },
  { method: 'get', path: `/inventory/${PRODUCT}/movements`, permission: 'inventory:read' },
  { method: 'get', path: `/inventory/${PRODUCT}/batches`, permission: 'inventory:read' },
  { method: 'post', path: `/inventory/${PRODUCT}/batches`, permission: 'inventory:receive' },
  {
    method: 'get',
    path: `/inventory/${PRODUCT}/batches/${BATCH}/recall`,
    permission: 'inventory:recall:read',
  },
  {
    method: 'post',
    path: `/inventory/${PRODUCT}/batches/${BATCH}/adjust`,
    permission: 'inventory:adjust',
  },
  {
    method: 'post',
    path: `/inventory/${PRODUCT}/batches/${BATCH}/write-off`,
    permission: 'inventory:write_off',
  },
];

/**
 * Which role holds which of those permissions.
 *
 * Also hand-written, and also deliberately not `can()` from `utils/permissions`.
 * Deriving the expectation from the same function the middleware calls would
 * make this suite a tautology: change the map and both sides move together, and
 * a pharmacist who gained `inventory:adjust` would sail through. `can()` has its
 * own suite; this one asks whether the routes enforce it.
 */
const HELD_BY_ROLE: Record<UserRole, readonly Permission[]> = {
  pharmacy_owner: ROUTE_TABLE.map((route) => route.permission),
  pharmacist: [
    'notifications:read',
    'inventory:alerts:scan',
    'inventory:import',
    'inventory:read',
    'inventory:product:write',
    'inventory:receive',
    'inventory:recall:read',
  ],
  staff: ['notifications:read', 'inventory:read', 'inventory:recall:read'],
};

beforeEach(() => {
  withTransactionMock.mockImplementation(async (work) =>
    work(CLIENT as unknown as Parameters<typeof work>[0])
  );
  withSavepointMock.mockImplementation(async (_client, _name, work) => work());

  findUserByIdMock.mockImplementation(async (id: string) => {
    if (id === OWNER_ID) return userRow(OWNER_ID, 'pharmacy_owner', { fullName: 'Beatrice Owusu' });
    if (id === PHARMACIST_ID) return userRow(PHARMACIST_ID, 'pharmacist', { fullName: 'Ama Mensah' });
    if (id === STAFF_ID) return userRow(STAFF_ID, 'staff', { fullName: 'Kojo Antwi' });
    return null;
  });

  insertProductMock.mockImplementation(async (_sql, input) => product(input));
  applyProductPatchMock.mockImplementation(async (_sql, _pharmacyId, _id, patch) => product(patch));
  findProductByIdMock.mockResolvedValue(product());
  findProductByCodeMock.mockResolvedValue(null);
  queryProductsMock.mockResolvedValue([product()]);
  lockProductMock.mockResolvedValue(product());
  listBatchesForProductMock.mockResolvedValue([batch()]);
  // The alert scan reads both of these and counts what comes back, so an
  // unimplemented mock returns undefined and the scan throws on `.length`.
  listActiveProductsMock.mockResolvedValue([]);
  listBatchesHoldingStockMock.mockResolvedValue([]);
  findBatchMock.mockResolvedValue(batch());
  findBatchByLotMock.mockResolvedValue(null);
  insertBatchMock.mockImplementation(async (_sql, input) =>
    batch({ ...input, id: 'a0000000-0000-4000-8000-000000000021' })
  );
  mergeIntoBatchMock.mockImplementation(async (_sql, id, quantity, costPrice) =>
    batch({ id, quantity: 100 + quantity, costPrice })
  );
  setBatchQuantityMock.mockImplementation(async (_sql, id, quantity) => batch({ id, quantity }));
  insertMovementMock.mockResolvedValue(undefined);
  queryMovementsMock.mockResolvedValue([movement()]);
  recallTraceMock.mockResolvedValue([sale()]);
  listNotificationsMock.mockResolvedValue([]);
});

describe('route order', () => {
  it('answers /alerts from the alerts handler, not from /:id with id "alerts"', async () => {
    const response = await call('get', '/inventory/alerts', ownerToken());

    // The discriminator is sharp. Had `/alerts` been declared after `/:id`, the
    // request would have matched `/:id` and `param('id').isUUID()` would have
    // refused "alerts" with a 400 naming a product id. A 200 carrying the
    // alerts envelope is only reachable through the alerts handler.
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.alerts).toEqual([]);
    expect(findProductByIdMock).not.toHaveBeenCalled();
  });

  it('says outright that the alerts it shows were never sent anywhere', async () => {
    const response = await call('get', '/inventory/alerts', ownerToken());

    // No SMS provider is configured, and the panel must not imply otherwise.
    // A pharmacist who believes an expiry warning was texted to somebody stops
    // checking the list themselves.
    expect(response.body.data.delivery).toContain('no SMS provider');
    expect(response.body.data.types).toEqual(['stock_reorder', 'stock_expiry']);
  });

  it('answers /import/template with the header line, not with a 400 about an id', async () => {
    const response = await call('get', '/inventory/import/template', ownerToken());

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toBe(KNOWN_IMPORT_COLUMNS.join(',') + '\n');
  });

  it('still refuses an id that is not a uuid, so the two cases above mean something', async () => {
    const response = await call('get', '/inventory/not-a-uuid', ownerToken());

    // Anti-vacuity for the ordering tests. If `/inventory/alerts` returned a 400
    // for every path, "the literal route won" and "the literal route lost" would
    // look identical. This proves the `/:id` route is live and validating.
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      { field: 'id', message: 'That is not a valid product id' },
    ]);
  });

  it('reaches the scan handler rather than a batch route', async () => {
    const response = await call('post', '/inventory/alerts/scan', ownerToken());

    // `/alerts/scan` and `/:id/batches` are both two segments deep. The second
    // segment differs, so there is no collision — asserted because "there is no
    // collision" is exactly the kind of thing that stops being true when a route
    // is added.
    expect(response.status).toBe(200);
    // The date is the real one: the route computes it so the scan stays testable
    // against a date in the past, and pinning it here would make this suite fail
    // every midnight for no reason.
    expect(response.body.data.scan.today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(response.body.data.scan.productsScanned).toBe(0);
    expect(response.body.data.scan.batchesScanned).toBe(0);
  });
});

describe('authorisation', () => {
  it.each(ROUTE_TABLE)('$method $path is refused for a role without $permission', async (route) => {
    const violations: string[] = [];

    for (const role of Object.keys(HELD_BY_ROLE) as UserRole[]) {
      const held = HELD_BY_ROLE[role].includes(route.permission);
      const response = await call(route.method, route.path, TOKENS[role]());

      if (held && (response.status === 403 || response.status === 401)) {
        violations.push(`${role} holds ${route.permission} but got ${response.status}`);
      }
      if (!held && response.status !== 403) {
        violations.push(`${role} lacks ${route.permission} but got ${response.status}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('names the permission it wanted, so a 403 can be explained at the counter', async () => {
    const response = await call(
      'post',
      `/inventory/${PRODUCT}/batches/${BATCH}/adjust`,
      pharmacistToken()
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
    expect(response.body.error.details).toEqual({ missing: ['inventory:adjust'] });
  });

  it('keeps adjusting and writing off owner-only, which is the control the brief asked for', async () => {
    // A pharmacist can receive stock but cannot silently change what the shelf
    // holds. Both of these routes are the ones a till operator must not reach,
    // and the difference between them and `inventory:receive` is the whole point
    // of splitting the permissions instead of using one `inventory:write`.
    for (const path of [
      `/inventory/${PRODUCT}/batches/${BATCH}/adjust`,
      `/inventory/${PRODUCT}/batches/${BATCH}/write-off`,
    ]) {
      const pharmacist = await call('post', path, pharmacistToken());
      const staff = await call('post', path, staffToken());
      expect(pharmacist.status).toBe(403);
      expect(staff.status).toBe(403);
    }
  });

  it('lets counter staff read stock and trace a recall, and nothing else on this router', async () => {
    expect(HELD_BY_ROLE.staff).toEqual([
      'notifications:read',
      'inventory:read',
      'inventory:recall:read',
    ]);
  });

  it('answers every route for its owner with something other than 401, 403 or 404', async () => {
    // A route that is mounted wrong answers 404, and a route that forgot
    // `authenticate` answers 401 for a valid token. Neither is a permission
    // failure, so the matrix above would not catch them.
    const broken: string[] = [];

    for (const route of ROUTE_TABLE) {
      const response = await call(route.method, route.path, ownerToken());
      if ([401, 403, 404].includes(response.status)) {
        broken.push(`${route.method.toUpperCase()} ${route.path} answered ${response.status}`);
      }
    }

    expect(broken).toEqual([]);
  });
});

describe('the derived columns, over HTTP', () => {
  /**
   * The four columns the database computes from the batches. A client that sends
   * them is either confused or trying to make the shelf say something it does
   * not, and both are answered the same way.
   */
  const FORGED = {
    quantity: 999,
    batchNumber: 'LOT-FORGED',
    expiryDate: '2030-01-01',
    costPrice: '1.0000',
  };

  const NEW_PRODUCT = { name: 'Paracetamol 500mg', code: 'PARA-500', unitPrice: '12.50' };

  it('refuses to write them on create, and says what it threw away', async () => {
    const response = await call('post', '/inventory', ownerToken()).send({
      ...NEW_PRODUCT,
      ...FORGED,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.discardedFields).toEqual([...DERIVED_PRODUCT_FIELDS]);
    expect(response.body.data.derivedFields).toEqual([...DERIVED_PRODUCT_FIELDS]);

    // The product that came back holds the figures the database computed, not
    // the ones that were sent. This is the assertion that would fail if the
    // stripping were removed and the response echoed the request.
    expect(response.body.data.product.quantity).toBe(100);
    expect(response.body.data.product.batchNumber).toBe('LOT-1');
    expect(response.body.data.product.costPrice).toBe('8.2500');

    const inserted = insertProductMock.mock.calls[0]?.[1];
    expect(inserted).toBeDefined();
    for (const field of DERIVED_PRODUCT_FIELDS) {
      expect(Object.keys(inserted as object)).not.toContain(field);
    }
  });

  it('refuses to write them on update, and the patch that reaches SQL is exact', async () => {
    const response = await call('patch', `/inventory/${PRODUCT}`, ownerToken()).send({
      name: 'Renamed',
      ...FORGED,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.discardedFields).toEqual([...DERIVED_PRODUCT_FIELDS]);

    // Exact equality, not `objectContaining`. `toProductPatch` builds the patch
    // by naming each field it accepts, so a key nobody named cannot reach the
    // statement — and an assertion that merely checked the four derived names
    // would not notice a fifth arriving through a spread.
    expect(applyProductPatchMock.mock.calls[0]?.[3]).toEqual({ name: 'Renamed' });
  });

  it('catches the snake_case spellings a spreadsheet or an old client would send', async () => {
    const response = await call('patch', `/inventory/${PRODUCT}`, ownerToken()).send({
      name: 'Renamed',
      quantity: 999,
      batch_number: 'LOT-FORGED',
      expiry_date: '2030-01-01',
      cost_price: '1.0000',
    });

    // Reported under the canonical camelCase name, so a client sees one spelling
    // regardless of which of the two it used.
    expect(response.body.data.discardedFields).toEqual([...DERIVED_PRODUCT_FIELDS]);
    expect(applyProductPatchMock.mock.calls[0]?.[3]).toEqual({ name: 'Renamed' });
  });

  it('catches the compact and capitalised spellings too', async () => {
    await call('patch', `/inventory/${PRODUCT}`, ownerToken()).send({
      name: 'Renamed',
      BATCHNUMBER: 'LOT-FORGED',
      expirydate: '2030-01-01',
      CostPrice: '1.0000',
    });

    expect(applyProductPatchMock.mock.calls[0]?.[3]).toEqual({ name: 'Renamed' });
  });

  it('includes discardedFields even when it is empty', async () => {
    const response = await call('post', '/inventory', ownerToken()).send(NEW_PRODUCT);

    expect(response.status).toBe(201);
    // Always present. A field that appears only when something went wrong makes
    // every client write `body.discardedFields ?? []`, and the one that forgets
    // reads `undefined` as "nothing discarded" for the wrong reason.
    expect(response.body.data.discardedFields).toEqual([]);
    expect(response.body.data.derivedFields).toEqual([...DERIVED_PRODUCT_FIELDS]);
  });

  it('will not let a body move the row to another product or another pharmacy', async () => {
    const response = await call('patch', `/inventory/${PRODUCT}`, ownerToken()).send({
      name: 'Renamed',
      id: 'a0000000-0000-4000-8000-000000000099',
      pharmacyId: 'b0000000-0000-4000-8000-000000000001',
    });

    expect(response.status).toBe(200);
    // `id` and `pharmacyId` are not derived columns, so they are not reported as
    // discarded — they are simply not among the fields the patch builder names.
    // The difference is worth pinning: a caller is told about the four columns it
    // might reasonably have tried to set, and gets silence about the two it
    // should never have been able to set at all.
    expect(response.body.data.discardedFields).toEqual([]);
    expect(applyProductPatchMock.mock.calls[0]?.[3]).toEqual({ name: 'Renamed' });
    // The id came from the path, which `authorize` and the pharmacy scope
    // already checked, not from the body.
    expect(applyProductPatchMock.mock.calls[0]?.[2]).toBe(PRODUCT);
  });
});

describe('validation at the boundary', () => {
  it('refuses a product with no name', async () => {
    const response = await call('post', '/inventory', ownerToken()).send({
      code: 'PARA-500',
      unitPrice: '12.50',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
    expect(response.body.error.details).toEqual([
      { field: 'name', message: 'Enter the product name as it appears on the box' },
    ]);
    expect(insertProductMock).not.toHaveBeenCalled();
  });

  it('refuses a selling unit outside the enum, and lists the ones that are allowed', async () => {
    const response = await call('post', '/inventory', ownerToken()).send({
      name: 'Paracetamol 500mg',
      code: 'PARA-500',
      unitPrice: '12.50',
      defaultSellUnit: 'crate',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].message).toBe('Selling unit must be one of single, pack');
  });

  it('refuses a received date in the future', async () => {
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const response = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      lotNumber: 'LOT-9',
      quantity: 10,
      receivedAt: nextWeek,
    });

    // `isISO8601()` accepts this: it is a perfectly well-formed timestamp. The
    // refusal comes from the service, which is why this suite does not mock it.
    // A delivery dated next week sorts ahead of every real lot in FEFO and is
    // picked last, so the stock would sit until it expired.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('received_at_in_future');
    expect(insertBatchMock).not.toHaveBeenCalled();
    expect(insertMovementMock).not.toHaveBeenCalled();
  });

  it('accepts the same field a day in the past, so the refusal above is about the future', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();

    const response = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      lotNumber: 'LOT-9',
      quantity: 10,
      receivedAt: yesterday,
    });

    expect(response.status).toBe(201);
  });

  it('refuses a receive with no lot number', async () => {
    const response = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      quantity: 10,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details[0]).toEqual({
      field: 'lotNumber',
      message: 'Enter the lot number printed on the delivery',
    });
  });

  it('refuses a receive of zero units', async () => {
    const response = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      lotNumber: 'LOT-9',
      quantity: 0,
    });

    // The minimum is 1. A delivery of nothing is a mis-keyed form, and accepting
    // it writes a ledger row that changes no stock and reads like a receipt.
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].message).toBe('Enter how many units arrived');
  });

  it('refuses an expiry date that is not a calendar date', async () => {
    const response = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      lotNumber: 'LOT-9',
      quantity: 10,
      expiryDate: '2030-13-45',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].message).toContain('YYYY-MM-DD');
  });

  it('demands a reason before it will adjust a batch', async () => {
    const response = await call(
      'post',
      `/inventory/${PRODUCT}/batches/${BATCH}/adjust`,
      ownerToken()
    ).send({ quantity: 40, note: 'Counted the shelf' });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      { field: 'reason', message: 'Enter why the stock is changing — this is the audit trail' },
    ]);
    expect(setBatchQuantityMock).not.toHaveBeenCalled();
  });

  it('demands a note as well, because a reason alone says nothing about what was counted', async () => {
    const response = await call(
      'post',
      `/inventory/${PRODUCT}/batches/${BATCH}/adjust`,
      ownerToken()
    ).send({ quantity: 40, reason: 'Stock count' });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      { field: 'note', message: 'Enter a note describing what was counted or what happened' },
    ]);
  });

  it('demands the same two before a write-off', async () => {
    const response = await call(
      'post',
      `/inventory/${PRODUCT}/batches/${BATCH}/write-off`,
      ownerToken()
    ).send({ quantity: 4 });

    expect(response.status).toBe(400);
    const fields = (response.body.error.details as { field: string }[]).map((d) => d.field);
    expect(fields.sort()).toEqual(['note', 'reason']);
  });

  it('does not demand them for a receive, where the delivery note is the reason', async () => {
    const response = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      lotNumber: 'LOT-9',
      quantity: 10,
    });

    // The asymmetry is deliberate. A correction changes a figure somebody
    // already believed; a receive adds stock against a supplier delivery that
    // exists whether or not it is typed in. Making both mandatory teaches the
    // pharmacist to type "." into the reason field, which is worse than optional.
    expect(response.status).toBe(201);
    expect(insertMovementMock).toHaveBeenCalled();
  });

  it('refuses a page size above the maximum', async () => {
    const response = await call('get', '/inventory?limit=999', ownerToken());

    expect(response.status).toBe(400);
    expect(response.body.error.details[0]).toEqual({
      field: 'limit',
      message: 'limit must be between 1 and 200',
    });
  });

  it('gives the same message for a field of the wrong type as for one left out', async () => {
    const response = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      lotNumber: 4041,
      quantity: 10,
    });

    // The other half of why the messages are chain defaults rather than a
    // `.withMessage()` on the last validator: a number in a text field fails
    // `isString()` first, which is a different validator from the one the
    // sentence was attached to.
    expect(response.status).toBe(400);
    expect(response.body.error.details[0]).toEqual({
      field: 'lotNumber',
      message: 'Enter the lot number printed on the delivery',
    });
  });

  it('names the limit when an optional field is too long', async () => {
    const response = await call('post', '/inventory', ownerToken()).send({
      name: 'Paracetamol 500mg',
      code: 'PARA-500',
      unitPrice: '12.50',
      category: 'c'.repeat(400),
    });

    // These five carry no `.withMessage()` at all, so a category pasted in from
    // a spreadsheet answered "Invalid value" and left the pharmacist to work out
    // which of thirteen fields it meant.
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe('category');
    expect(response.body.error.details[0].message).toMatch(
      /^Enter a category of \d+ characters or fewer$/u
    );
  });

  it('never answers with the validator\'s own "Invalid value"', async () => {
    /**
     * Every way a body on this router can be wrong: absent, empty, the wrong
     * type, too long, outside an enum.
     *
     * Swept rather than sampled, because the failure it guards is a validator
     * somebody adds later without a message. That produces a correct 400 with a
     * useless sentence in it, which no single-field test would notice and no
     * pharmacist would report — they would just stand at the counter not knowing
     * which cell to fix.
     */
    const wrong: { method: 'post' | 'patch'; path: string; body: object }[] = [
      { method: 'post', path: '/inventory', body: {} },
      { method: 'post', path: '/inventory', body: { name: 42, code: 7, unitPrice: '1.00' } },
      {
        method: 'post',
        path: '/inventory',
        body: { name: 'x'.repeat(400), code: 'y'.repeat(400), unitPrice: '1.00' },
      },
      ...(
        ['genericName', 'category', 'manufacturer', 'shelfLocation', 'barcode'] as const
      ).map((field) => ({
        method: 'post' as const,
        path: '/inventory',
        body: { name: 'A', code: 'A-1', unitPrice: '1.00', [field]: 'z'.repeat(400) },
      })),
      ...(
        [
          ['packSize', 'many'],
          ['defaultSellUnit', 'crate'],
          ['requiresPrescription', 'maybe'],
          ['reorderLevel', -3],
          ['vatTreatment', 'sometimes'],
          ['isActive', 'yes please'],
        ] as [string, unknown][]
      ).map(([field, value]) => ({
        method: 'post' as const,
        path: '/inventory',
        body: { name: 'A', code: 'A-1', unitPrice: '1.00', [field]: value },
      })),
      { method: 'patch', path: `/inventory/${PRODUCT}`, body: { name: 42 } },
      { method: 'post', path: `/inventory/${PRODUCT}/batches`, body: {} },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches`,
        body: { lotNumber: 4041, quantity: 'ten' },
      },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches`,
        body: { lotNumber: 'LOT-9', quantity: 10, expiryDate: '31/12/2030' },
      },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches`,
        body: { lotNumber: 'LOT-9', quantity: 10, receivedAt: 'last tuesday' },
      },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches`,
        body: { lotNumber: 'LOT-9', quantity: 10, reason: 'x' },
      },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches`,
        body: { lotNumber: 'LOT-9', quantity: 10, note: 'n'.repeat(900) },
      },
      { method: 'post', path: `/inventory/${PRODUCT}/batches/${BATCH}/adjust`, body: {} },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches/${BATCH}/adjust`,
        body: { quantity: 'forty', reason: 1, note: 2 },
      },
      { method: 'post', path: `/inventory/${PRODUCT}/batches/${BATCH}/write-off`, body: {} },
      // The money fields carry no validator on the route at all — a JSON client
      // sends a number and a CSV cell sends a string, so `utils/coerce` decides
      // in the service. That makes them the one family here whose message could
      // regress without any route change, and the sweep is the only thing that
      // would notice.
      { method: 'post', path: '/inventory', body: { name: 'A', code: 'A-1', unitPrice: 'free' } },
      { method: 'post', path: '/inventory', body: { name: 'A', code: 'A-1', unitPrice: -5 } },
      // Whitespace-only. `.trim()` runs before `.isLength()`, so these arrive as
      // a present string that is too short — the one shape the cases above do
      // not reach, and the shape a trailing `.withMessage()` gets wrong in the
      // opposite direction from a missing field.
      {
        method: 'post',
        path: '/inventory',
        body: { name: '   ', code: '   ', unitPrice: '1.00' },
      },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches`,
        body: { lotNumber: '   ', quantity: 10 },
      },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches`,
        body: { lotNumber: 'L'.repeat(400), quantity: 10 },
      },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches/${BATCH}/adjust`,
        body: { quantity: 1, reason: 'x', note: 'counted the shelf' },
      },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches/${BATCH}/adjust`,
        body: { quantity: -1, reason: 'damaged in transit', note: 'counted the shelf' },
      },
      {
        method: 'post',
        path: `/inventory/${PRODUCT}/batches/${BATCH}/write-off`,
        body: { quantity: 1, reason: 'expired', note: '   ' },
      },
    ];

    const offenders: string[] = [];

    for (const entry of wrong) {
      const response = await call(entry.method, entry.path, ownerToken()).send(entry.body);
      const body = JSON.stringify(response.body);

      // Both halves matter. A 200 would mean the case was not a case at all and
      // the sweep was quietly testing nothing; "Invalid value" is the defect.
      if (response.status !== 400) {
        offenders.push(`${entry.path} ${body} answered ${response.status}`);
      }
      if (body.includes('Invalid value')) {
        offenders.push(`${entry.path} ${body}`);
      }
    }

    expect(wrong.length).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });
});

describe('status codes', () => {
  it('answers 201 for a new lot and 200 when the lot already existed', async () => {
    const created = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      lotNumber: 'LOT-9',
      quantity: 10,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.merged).toBe(false);
    expect(insertBatchMock).toHaveBeenCalledTimes(1);

    findBatchByLotMock.mockResolvedValue(batch({ lotNumber: 'LOT-9', quantity: 100 }));
    const topped = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      lotNumber: 'LOT-9',
      quantity: 10,
      expiryDate: FUTURE,
    });

    // 200 rather than 201, because nothing was created: the delivery topped up a
    // lot already on the shelf. A till that announced "new batch added" here
    // would be describing a row that does not exist.
    //
    // The expiry is sent to match the existing lot on purpose. Receiving the same
    // lot with a different date is a 409, because it would silently change the
    // expiry of stock already on the shelf.
    expect(topped.status).toBe(200);
    expect(topped.body.data.merged).toBe(true);
    expect(mergeIntoBatchMock).toHaveBeenCalledTimes(1);
    expect(insertBatchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to top up a lot with a different expiry date', async () => {
    findBatchByLotMock.mockResolvedValue(batch({ lotNumber: 'LOT-9', expiryDate: FUTURE }));

    const response = await call('post', `/inventory/${PRODUCT}/batches`, ownerToken()).send({
      lotNumber: 'LOT-9',
      quantity: 10,
      expiryDate: '2031-06-30',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('lot_expiry_conflict');
    expect(mergeIntoBatchMock).not.toHaveBeenCalled();
  });

  it('answers 201 on create and 200 on update', async () => {
    const created = await call('post', '/inventory', ownerToken()).send({
      name: 'Paracetamol 500mg',
      code: 'PARA-500',
      unitPrice: '12.50',
    });
    const updated = await call('patch', `/inventory/${PRODUCT}`, ownerToken()).send({
      name: 'Renamed',
    });

    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
  });

  it('answers 422 when the file was read but nothing in it could be imported', async () => {
    const response = await call('post', '/inventory/import', ownerToken())
      .set('Content-Type', 'text/csv')
      .send('name,code,unit_price\nParacetamol 500mg,PARA-500,not a price\n');

    // Not 400, which would say "we could not read this" — the file was read
    // perfectly and one cell in it was wrong. Not 200, which would say it worked.
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('csv_nothing_imported');
    expect(response.body.error.details.rowsInFile).toBe(1);
    expect(response.body.error.details.failed).toHaveLength(1);
    expect(response.body.error.details.failed[0].line).toBe(2);
  });

  it('answers 400 when no file arrived at all', async () => {
    const response = await call('post', '/inventory/import', ownerToken()).send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('csv_body_missing');
  });

  it('refuses a file with a column it does not use, before writing anything', async () => {
    const response = await call('post', '/inventory/import', ownerToken())
      .set('Content-Type', 'text/csv')
      .send('name,code,unit_price,expirty_date\nA,A-1,1.00,2030-01-01\n');

    // Refused rather than ignored. A header typo would otherwise import every row
    // with no expiry at all and report success, and the pharmacy would find out
    // when stock started disappearing without ever having been dated.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('csv_unknown_columns');
    expect(response.body.error.message).toContain('expirty_date');
    expect(insertProductMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('takes the file as text/csv and as JSON with the file in a "csv" field', async () => {
    const file = 'name,code,unit_price\nParacetamol 500mg,PARA-500,12.50\n';

    const asText = await call('post', '/inventory/import', ownerToken())
      .set('Content-Type', 'text/csv')
      .send(file);
    const asJson = await call('post', '/inventory/import', ownerToken()).send({ csv: file });

    // Two shapes, because a browser uploading a file produces the first and an
    // API client that would otherwise need a multipart dependency produces the
    // second.
    expect(asText.status).toBe(200);
    expect(asJson.status).toBe(200);
    expect(asText.body.data.imported).toHaveLength(1);
    expect(asJson.body.data.imported).toHaveLength(1);
  });

  it('answers 200 with a partial report when some rows landed and some did not', async () => {
    const response = await call('post', '/inventory/import', ownerToken())
      .set('Content-Type', 'text/csv')
      .send(
        'name,code,unit_price\nParacetamol 500mg,PARA-500,12.50\nIbuprofen,IBU-400,not a price\n'
      );

    // 200 rather than 422: the work was done, and the report says which row needs
    // fixing. Answering 4xx here would tell the pharmacist to re-upload the good
    // row too, and create a duplicate.
    expect(response.status).toBe(200);
    expect(response.body.data.partial).toBe(true);
    expect(response.body.data.imported).toHaveLength(1);
    expect(response.body.data.failed).toHaveLength(1);
    expect(response.body.data.failed[0].line).toBe(3);
  });

  it('never lets a row failure escape as a statement about the database', async () => {
    const response = await call('post', '/inventory/import', ownerToken())
      .set('Content-Type', 'text/csv')
      .send('name,code,unit_price\nParacetamol 500mg,PARA-500,not a price\n');

    // The body is the only thing the caller sees, so it is the only place a
    // table or column name could leak. Checked as text rather than field by
    // field, because the point is that neither word appears anywhere in it.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('inventory_products');
    expect(body).not.toContain('unit_price');
  });
});

describe('lists and pagination', () => {
  it('passes limit and offset through to the query', async () => {
    const response = await call('get', '/inventory?limit=5&offset=10', ownerToken());

    expect(response.status).toBe(200);
    expect(queryProductsMock.mock.calls[0]?.[2]).toEqual({
      includeInactive: false,
      limit: 5,
      offset: 10,
    });
    expect(response.body.data.limit).toBe(5);
    expect(response.body.data.offset).toBe(10);
  });

  it('defaults to the first fifty', async () => {
    await call('get', '/inventory', ownerToken());

    expect(queryProductsMock.mock.calls[0]?.[2]).toEqual({
      includeInactive: false,
      limit: 50,
      offset: 0,
    });
  });

  it('does not send an empty search or category as a filter', async () => {
    await call('get', '/inventory?search=&category=', ownerToken());

    // Exact equality, so an empty string cannot slip through as a term. A search
    // for nothing should list everything, and a filter built from '' is a
    // `LIKE '%%'` that costs a sequential scan for the same answer.
    expect(queryProductsMock.mock.calls[0]?.[2]).toEqual({
      includeInactive: false,
      limit: 50,
      offset: 0,
    });
  });

  it('passes a search, a category and includeInactive through when they are filled in', async () => {
    await call(
      'get',
      '/inventory?search=para&category=Analgesic&includeInactive=true',
      ownerToken()
    );

    expect(queryProductsMock.mock.calls[0]?.[2]).toEqual({
      search: 'para',
      category: 'Analgesic',
      includeInactive: true,
      limit: 50,
      offset: 0,
    });
  });

  it('returns the batch panel from the same read as the product card', async () => {
    const response = await call('get', `/inventory/${PRODUCT}/batches`, ownerToken());

    expect(response.status).toBe(200);
    expect(response.body.data.batches).toHaveLength(1);
    expect(response.body.data.sellable).toBe(100);
    expect(response.body.data.leading.lotNumber).toBe('LOT-1');
    // One read feeds both panels, so the product card and the batch list cannot
    // disagree about how much stock there is.
    expect(findProductByIdMock).toHaveBeenCalledTimes(1);
    expect(listBatchesForProductMock).toHaveBeenCalledTimes(1);
  });

  it('answers a recall trace with the sales that touched the batch', async () => {
    const response = await call(
      'get',
      `/inventory/${PRODUCT}/batches/${BATCH}/recall`,
      staffToken()
    );

    // Counter staff hold `inventory:recall:read`: when a supplier calls about a
    // batch, the person who answers the phone is not the owner.
    expect(response.status).toBe(200);
    expect(recallTraceMock).toHaveBeenCalled();
    expect(response.body.data.sales[0].saleNumber).toBe('S-0001');
    expect(Array.isArray(response.body.data.contacts)).toBe(true);
    // Voided sales stay in the list with their status rather than being filtered
    // out: a recall is a safety operation, and quietly dropping records is the
    // wrong default even when the record is one that was cancelled.
    expect(response.body.data.sales).toHaveLength(1);
  });

  it('answers the movement ledger for one product, with the page size it was given', async () => {
    const response = await call('get', `/inventory/${PRODUCT}/movements?limit=25`, ownerToken());

    expect(response.status).toBe(200);
    expect(queryMovementsMock.mock.calls[0]?.[3]).toBe(25);
    expect(response.body.data.movements).toHaveLength(1);
  });

  it('answers 404 for a product that is not there', async () => {
    findProductByIdMock.mockResolvedValue(null);

    const response = await call('get', `/inventory/${PRODUCT}`, ownerToken());

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});
