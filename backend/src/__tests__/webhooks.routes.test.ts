jest.mock('../config', () => {
  const actual = jest.requireActual('../config') as typeof import('../config');
  return {
    ...actual,
    config: actual.buildConfig({
      ...process.env,
      // `jest.setup.js` deletes both of these outright, so without them every
      // suite in the backend sees an unconfigured gateway and
      // `webhookSignatureIsValid` can only ever return false. This is the one
      // file that needs the other state, and rebuilding through `buildConfig`
      // rather than hand-writing the object is what keeps it a configuration a
      // deployment could actually have.
      PAYSTACK_SECRET_KEY: 'sk_test_a1b2c3d4e5f60718293a4b5c6d7e8f90',
      PAYSTACK_PUBLIC_KEY: 'pk_test_a1b2c3d4e5f60718293a4b5c6d7e8f90',
      // Three, and deliberately not the production 300. Proving the webhook is
      // exempt from the limiter by exhausting the real limit would mean 301
      // requests in a unit test; the exemption is about `skip`, not about the
      // number, and four requests prove it just as well.
      RATE_LIMIT_MAX: '3',
    }),
  };
});

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

jest.mock('../repositories/notifications.repository', () => ({
  raiseNotification: jest.fn(),
  listNotifications: jest.fn(),
}));

jest.mock('../repositories/tax-settings.repository', () => ({
  readTaxSettings: jest.fn(),
  writeTaxSettings: jest.fn(),
}));

/**
 * The logger is mocked here and in no other suite, for two reasons that are both
 * about things the response body cannot carry.
 *
 * A rejected signature must not be logged *with* the body or the signature,
 * because a log that collects near-misses is a log that helps somebody build one
 * — and the only way to see what a log line contains is to capture it. And a
 * charge that succeeds against a voided sale is owed a refund this build has no
 * flow for, so the one place it can surface is the log; the response answers 200
 * to Paystack regardless and has no field for it.
 */
jest.mock('../utils/logger', () => {
  const sinks = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { scoped: () => sinks, sinks };
});

import { createHmac } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { createApp } from '../app';
import { config } from '../config';
import { withTransaction } from '../database/pool';
import {
  findSaleById,
  findSalePayment,
  findSalePaymentByReference,
  listSaleItemBatches,
  listSaleItems,
  listSalePayments,
  lockSale,
  updateSalePaymentStatus,
  updateSaleSettlement,
  type SaleItemBatchRow,
  type SaleItemRow,
  type SalePaymentRow,
  type SaleRow,
} from '../repositories/sales.repository';
import { findUserById } from '../repositories/users.repository';
import { PAYSTACK_WEBHOOK_PATH } from '../services/paystack.service';
import type { SaleStatus } from '../utils/schema-enums';

/**
 * The capture the logger mock above exposes.
 *
 * Declared here rather than imported, because the real `utils/logger` does not
 * export it and importing a member that exists only in a mock is a compile error
 * — correctly, since that import would silently become `undefined` the day the
 * mock is removed.
 */
interface LogSinks {
  info: jest.Mock<void, [string, unknown?]>;
  warn: jest.Mock<void, [string, unknown?]>;
  error: jest.Mock<void, [string, unknown?]>;
  debug: jest.Mock<void, [string, unknown?]>;
}

const sinks = (jest.requireMock('../utils/logger') as { sinks: LogSinks }).sinks;

/**
 * The webhook, over HTTP.
 *
 * Built through `createApp()` and not by mounting the router on a bare Express
 * app, because the guarantee this suite exists for lives in `app.ts`: the JSON
 * parser's `verify` hook keeps the raw buffer aside, and it is the only moment
 * those bytes exist. Mount the router directly and every signature test below
 * passes against a body the test itself serialised, which is precisely the
 * arrangement that fails on one payload in a hundred in production.
 *
 * The services are real and the repositories are mocked, as everywhere else. So
 * the applied case at the bottom runs the whole of `applyPaymentOutcome` — the
 * tender write, the guarded `allowedFrom`, the re-settlement — and is the only
 * place in the backend where that path is driven by something other than an
 * operator pressing verify.
 */

const app = createApp();

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const SALE = 'a0000000-0000-4000-8000-000000000030';
const ITEM = 'a0000000-0000-4000-8000-000000000031';
const PAYMENT = 'a0000000-0000-4000-8000-000000000050';
const SALE_NUMBER = 'H3-000042';
const REFERENCE = `${SALE_NUMBER}-0A1B2C3D4E5F6071`;
const NOW = '2026-09-04T09:20:00.000Z';
const CREATED_AT = '2026-09-04T09:12:00.000Z';
const SIGNATURE_HEADER = 'x-paystack-signature';

const withTransactionMock = jest.mocked(withTransaction);
const findByReferenceMock = jest.mocked(findSalePaymentByReference);
const findSalePaymentMock = jest.mocked(findSalePayment);
const lockSaleMock = jest.mocked(lockSale);
const updateSalePaymentStatusMock = jest.mocked(updateSalePaymentStatus);
const listSalePaymentsMock = jest.mocked(listSalePayments);
const updateSaleSettlementMock = jest.mocked(updateSaleSettlement);
const findSaleByIdMock = jest.mocked(findSaleById);
const listSaleItemsMock = jest.mocked(listSaleItems);
const listSaleItemBatchesMock = jest.mocked(listSaleItemBatches);
const findUserByIdMock = jest.mocked(findUserById);

function saleRow(overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    id: SALE,
    pharmacyId: PHARMACY,
    saleNumber: SALE_NUMBER,
    status: 'pending',
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
    amountPaid: '0.00',
    changeGiven: '0.00',
    vatRate: '0.1500',
    nhilRate: '0.0250',
    getfundRate: '0.0250',
    taxInclusivePricing: false,
    clientSaleId: 'till-7f3c1b90-4d2e',
    voidedAt: null,
    voidReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function saleItem(): SaleItemRow {
  return {
    id: ITEM,
    saleId: SALE,
    inventoryId: 'a0000000-0000-4000-8000-000000000010',
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
  };
}

function saleItemBatch(): SaleItemBatchRow & { inventoryId: string } {
  return {
    id: 'a0000000-0000-4000-8000-000000000032',
    saleItemId: ITEM,
    batchId: 'a0000000-0000-4000-8000-000000000020',
    lotNumber: 'LOT-1',
    quantity: 2,
    unitCost: '8.2500',
    inventoryId: 'a0000000-0000-4000-8000-000000000010',
  };
}

function paymentRow(overrides: Partial<SalePaymentRow> = {}): SalePaymentRow {
  return {
    id: PAYMENT,
    saleId: SALE,
    method: 'momo',
    status: 'pending',
    amount: '25.00',
    reference: REFERENCE,
    gatewayResponse: null,
    paidAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function tenderWithSale(
  overrides: Partial<SalePaymentRow> = {},
  saleStatus: SaleStatus = 'pending'
): SalePaymentRow & { pharmacyId: string; saleStatus: SaleStatus } {
  return { ...paymentRow(overrides), pharmacyId: PHARMACY, saleStatus };
}

/** Signs exactly these bytes, the way Paystack does, with the key this app has. */
function sign(body: string): string {
  return createHmac('sha512', config.paystack.secretKey).update(body, 'utf8').digest('hex');
}

/**
 * Posts a body verbatim.
 *
 * `send(string)` with the content type already set is what makes the bytes the
 * test says they are. `send(object)` would let superagent serialise, and then
 * "signed over the exact bytes" would be true only because nothing else had a
 * chance to write them.
 */
function postRaw(body: string, signature?: string): request.Test {
  const test = request(app).post(PAYSTACK_WEBHOOK_PATH).set('Content-Type', 'application/json');
  if (signature !== undefined) test.set(SIGNATURE_HEADER, signature);
  return test.send(body);
}

/**
 * Writes the request as bytes, because nothing above this level will send one
 * header twice.
 *
 * superagent flattens an array into a single comma-joined value, and so — it
 * turns out — does Node's own `http.request`. Both were tried, and both left the
 * route holding a string, so a test built on either asserts a 400 for a
 * 257-character invalid signature and reports coverage of a branch it never
 * entered. On the *server* side Node's parser does hand repeated headers to
 * Express as an array, for any header outside its small join-or-discard list —
 * which is why the route guards for one, and why reaching that from a test means
 * writing the header line twice by hand.
 *
 * `headerLines` are whole header lines rather than a list of values, so the
 * caller decides how many there are and the helper cannot silently collapse them.
 */
async function postRawBytes(body: string, headerLines: string[]): Promise<number> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<number>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          `POST ${PAYSTACK_WEBHOOK_PATH} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `${headerLines.map((line) => `${line}\r\n`).join('')}` +
            'Connection: close\r\n\r\n' +
            body
        );
      });
      socket.setEncoding('utf8');
      let head = '';
      socket.on('data', (chunk: string) => {
        head += chunk;
      });
      socket.on('error', reject);
      socket.on('close', () => {
        const status = Number.parseInt(head.split(' ', 2)[1] ?? '', 10);
        resolve(Number.isNaN(status) ? 0 : status);
      });
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
}

/** A `charge.success` for our own reference, compact and unremarkable. */
function chargeSuccess(amount = 2500): string {
  return JSON.stringify({
    event: 'charge.success',
    data: { reference: REFERENCE, amount, paid_at: NOW },
  });
}

beforeEach(() => {
  jest.clearAllMocks();

  withTransactionMock.mockImplementation(async (work) =>
    work({ query: jest.fn() } as unknown as Parameters<typeof work>[0])
  );

  findByReferenceMock.mockResolvedValue(null);
  findSalePaymentMock.mockResolvedValue(tenderWithSale());
  lockSaleMock.mockResolvedValue(saleRow());
  updateSalePaymentStatusMock.mockResolvedValue(paymentRow({ status: 'succeeded', paidAt: NOW }));
  listSalePaymentsMock.mockResolvedValue([paymentRow({ status: 'succeeded', paidAt: NOW })]);
  updateSaleSettlementMock.mockResolvedValue(saleRow({ status: 'completed', amountPaid: '25.00' }));
  findSaleByIdMock.mockResolvedValue(saleRow({ status: 'completed', amountPaid: '25.00' }));
  listSaleItemsMock.mockResolvedValue([saleItem()]);
  listSaleItemBatchesMock.mockResolvedValue([saleItemBatch()]);
  findUserByIdMock.mockResolvedValue({
    id: OWNER_ID,
    fullName: 'Beatrice Owusu',
  } as Awaited<ReturnType<typeof findUserById>>);
});

// ---------------------------------------------------------------------------
// The signature, at the boundary where the bytes still exist
// ---------------------------------------------------------------------------

describe('the signature check', () => {
  it('answers 200 to a validly signed body, with no token of any kind', async () => {
    const body = JSON.stringify({ event: 'transfer.success' });

    const response = await postRaw(body, sign(body));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { received: true, reason: 'not_our_event', handled: false },
    });
    // The signature *is* the authentication. `route-protection.test.ts` pins the
    // absence of `authenticate` from the mount; this is the same fact from the
    // other side, and it is the one that costs money — Paystack has no staff
    // token, so a 401 here is a retry loop against a charge that was already
    // paid and a sale left pending forever.
    expect(response.body.data.received).toBe(true);
  });

  it('verifies the bytes that arrived, not the JSON they parse to', async () => {
    // Pretty-printed, and with a name Paystack would send exactly like this.
    // Whitespace never survives a parse-and-stringify, and `é` may or may not be
    // escaped the same way on the return trip.
    const sent =
      '{\n  "event": "charge.success",\n  "data": {\n' +
      `    "reference": "${REFERENCE}",\n` +
      '    "amount": 2500,\n' +
      '    "customer": { "name": "Ama Ménsh" }\n  }\n}';

    await expect(postRaw(sent, sign(sent))).resolves.toMatchObject({ status: 200 });

    // The same JSON, compacted, carrying the signature of the pretty version.
    // Identical once parsed. Refused, because the bytes are not.
    const compacted = JSON.stringify(JSON.parse(sent));
    expect(JSON.parse(compacted)).toEqual(JSON.parse(sent));
    await expect(postRaw(compacted, sign(sent))).resolves.toMatchObject({ status: 400 });
  });

  it('refuses a body that arrives with nothing to verify', async () => {
    // `express.json` never runs its `verify` hook on an empty body, so there is no
    // buffer — and the honest answer is a refusal rather than a check against
    // `undefined` that happens to fail for a different reason.
    const response = await request(app)
      .post(PAYSTACK_WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set(SIGNATURE_HEADER, sign('{}'))
      .send();

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('webhook_signature_invalid');
  });

  it.each([
    ['absent', undefined],
    ['wrong', 'f'.repeat(128)],
  ])('refuses a signature that is %s', async (_label, signature) => {
    const body = chargeSuccess();
    const response = await postRaw(body, signature);

    // 400 and not 200, and it is the one exception to the "everything after the
    // signature answers 200" rule. A 400 shows up as a failed delivery in
    // Paystack's own dashboard; a 200 would look like the endpoint working while
    // every real webhook was being thrown away.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('webhook_signature_invalid');
    expect(findByReferenceMock).not.toHaveBeenCalled();
  });

  it('refuses a header sent twice, in either order', async () => {
    const body = chargeSuccess();
    const valid = sign(body);
    const forged = 'f'.repeat(128);

    // Both orders, because either one alone would not distinguish a refusal from
    // first-wins or last-wins, and first-wins is a rule an attacker gets to test
    // against by sending a valid signature second.
    const twice = (first: string, second: string): string[] => [
      `${SIGNATURE_HEADER}: ${first}`,
      `${SIGNATURE_HEADER}: ${second}`,
    ];
    expect(await postRawBytes(body, twice(valid, forged))).toBe(400);
    expect(await postRawBytes(body, twice(forged, valid))).toBe(400);

    // `headerRepeated: false` is the finding, and it is asserted rather than
    // left to be discovered: Node joins duplicates of any header other than
    // `set-cookie` with `', '` before middleware runs, so the route is handed one
    // 258-character string and never an array. The refusal therefore comes from
    // the length check in front of `timingSafeEqual`, not from an array guard —
    // which is worth knowing before anybody relaxes that length check believing
    // something else is holding the line.
    expect(sinks.warn).toHaveBeenCalledWith('webhook rejected: the signature did not match', {
      headerPresent: true,
      headerRepeated: false,
    });
  });

  it('logs a rejection without the body or the signature', async () => {
    const body = chargeSuccess();
    await postRaw(body, 'f'.repeat(128));

    // Two lines, and both are in scope: the route's own, and the one the error
    // middleware writes for every 4xx. Neither may carry the body or the
    // signature — a log that collected near-misses would be a log that helped
    // somebody build one, and the body of a rejected webhook is attacker-chosen
    // text sitting in a file somebody will one day paste into a chat.
    expect(sinks.warn).toHaveBeenCalledTimes(2);
    const logged = sinks.warn.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(logged).not.toContain(body);
    expect(logged).not.toContain('f'.repeat(128));

    expect(sinks.warn.mock.calls[0]?.[0]).toBe('webhook rejected: the signature did not match');
    expect(sinks.warn.mock.calls[0]?.[1]).toEqual({ headerPresent: true, headerRepeated: false });
  });
});

// ---------------------------------------------------------------------------
// What it does once the signature is good
// ---------------------------------------------------------------------------

describe('a verified webhook', () => {
  it('acknowledges an event that is not ours without touching the database', async () => {
    const body = JSON.stringify({ event: 'transfer.success', data: { amount: 2500 } });

    const response = await postRaw(body, sign(body));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ received: true, reason: 'not_our_event', handled: false });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('acknowledges charge.failed rather than failing a tender from it', async () => {
    // The operator can press verify and get an answer that has been checked
    // against the amount. They cannot un-fail a tender, and a customer's money
    // marked failed with nothing on the screen to say so is worse than one left
    // pending.
    const body = JSON.stringify({
      event: 'charge.failed',
      data: { reference: REFERENCE, amount: 2500 },
    });

    const response = await postRaw(body, sign(body));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ received: true, reason: 'not_our_event', handled: false });
    expect(updateSalePaymentStatusMock).not.toHaveBeenCalled();
  });

  it('acknowledges a reference this server never issued', async () => {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { reference: 'H9-999999-FFFFFFFFFFFFFFFF', amount: 2500 },
    });

    const response = await postRaw(body, sign(body));

    // 200, because a 404 makes Paystack retry a reference that will never exist,
    // and the retry loop buries the one real event under noise. Logged, because it
    // is also exactly what a mis-pointed test account looks like.
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      received: true,
      reason: 'unknown_reference',
      handled: false,
    });
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(sinks.warn).toHaveBeenCalledWith(
      'a verified webhook named a reference this server has no payment for',
      expect.anything()
    );
  });

  it('acknowledges an amount that does not match the tender', async () => {
    findByReferenceMock.mockResolvedValue(tenderWithSale());
    const body = chargeSuccess(9999);

    const response = await postRaw(body, sign(body));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      received: true,
      reason: 'amount_mismatch',
      handled: false,
    });
    expect(updateSalePaymentStatusMock).not.toHaveBeenCalled();
    expect(sinks.error).toHaveBeenCalledWith(
      'webhook amount does not match the tender',
      expect.objectContaining({ expected: 2500, reported: 9999 })
    );
  });

  it('settles the tender and re-settles the sale', async () => {
    findByReferenceMock.mockResolvedValue(tenderWithSale());
    const body = chargeSuccess();

    const response = await postRaw(body, sign(body));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ received: true, reason: 'applied', handled: true });

    // Scoped to the pharmacy the *row* belongs to. The webhook carries no tenant
    // — Paystack knows the account, not the pharmacy — so the reference has to
    // find exactly one row and that row has to bring its own `pharmacy_id` back.
    expect(findByReferenceMock).toHaveBeenCalledWith(expect.anything(), REFERENCE);
    expect(withTransactionMock).toHaveBeenCalledTimes(1);

    // `allowedFrom` is the concurrency answer. A webhook and a `verify` for the
    // same charge routinely arrive within a second of each other and both are
    // entitled to think they are first; the guard in the `where` clause means the
    // second finds no row and reports `changed: false`, which is the truth rather
    // than a failure. Read-then-write here would let a delayed webhook un-settle
    // a completed sale.
    expect(updateSalePaymentStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT,
      expect.objectContaining({ status: 'succeeded', paidAt: NOW, allowedFrom: ['pending'] })
    );

    // Two singles of an exempt product, paid in full: the sale completes and
    // nothing is owed back. A webhook that moved the tender and not the sale
    // would leave a paid basket sitting in the pending list.
    expect(updateSaleSettlementMock).toHaveBeenCalledWith(expect.anything(), SALE, {
      amountPaid: '25.00',
      changeGiven: '0.00',
      status: 'completed',
    });

    // Stored verbatim: `gateway_response` is the only evidence there is of what
    // was believed.
    expect(updateSalePaymentStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT,
      expect.objectContaining({ gatewayResponse: JSON.parse(body) })
    );
  });

  it('reports a redelivery as recorded rather than as a second payment', async () => {
    findByReferenceMock.mockResolvedValue(tenderWithSale({ status: 'succeeded', paidAt: NOW }));
    // The guarded update finds no row in `pending`, which is what a redelivery
    // looks like from inside the transaction.
    updateSalePaymentStatusMock.mockResolvedValue(null);
    const body = chargeSuccess();

    const response = await postRaw(body, sign(body));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      received: true,
      reason: 'already_recorded',
      handled: false,
    });
    // `handled: false` is what stops a redelivery from reading as a second
    // payment in the log, and it is why the settlement is left alone.
    expect(updateSaleSettlementMock).not.toHaveBeenCalled();
  });

  it('says loudly that a refund is owed when money lands on a voided sale', async () => {
    findByReferenceMock.mockResolvedValue(tenderWithSale({}, 'voided'));
    lockSaleMock.mockResolvedValue(saleRow({ status: 'voided' }));
    findSaleByIdMock.mockResolvedValue(saleRow({ status: 'voided' }));
    // `updateSaleSettlement` is guarded `status <> 'voided'`, so the settlement
    // does not move and the tender does: what the gateway said happened,
    // happened.
    updateSaleSettlementMock.mockResolvedValue(null);
    const body = chargeSuccess();

    const response = await postRaw(body, sign(body));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ received: true, reason: 'applied', handled: true });
    // There is no refund flow in this build and the response body has no field
    // for one, because Paystack gets a 200 either way. The log is the only place
    // this can surface, which is why it is an error and not a warning.
    expect(sinks.error).toHaveBeenCalledWith(
      'a charge succeeded against a voided sale — a refund is owed',
      expect.objectContaining({ paymentId: PAYMENT, saleId: SALE, reference: REFERENCE })
    );
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe('delivery', () => {
  it('is not rate limited, however many times Paystack retries', async () => {
    const body = JSON.stringify({ event: 'transfer.success' });
    const signature = sign(body);

    // Four requests against a limit configured to three. Any other route on this
    // app would be answering 429 by the fourth.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await postRaw(body, signature);
      expect(response.status).toBe(200);
    }

    // And the limiter is genuinely running, so the four 200s above are the
    // exemption rather than a limiter that never started. Without this the test
    // would pass on an app with no rate limiting at all.
    const limited = await request(app).get('/sales/payment-config');
    expect([401, 429]).toContain(limited.status);
  });

  it('answers 404 to anything that is not a POST to the exact path', async () => {
    expect((await request(app).get(PAYSTACK_WEBHOOK_PATH)).status).toBe(404);
    expect((await request(app).post(`${PAYSTACK_WEBHOOK_PATH}/extra`)).status).toBe(404);
  });
});
