jest.mock('../config', () => {
  const actual = jest.requireActual('../config') as typeof import('../config');
  return {
    ...actual,
    // Rebuilt through the real `buildConfig` rather than hand-written, so this
    // suite sees a `PaystackConfig` that has been through the same derivation a
    // deployment sees — including the rule that two keys from different
    // environments report `configured: false`. Hand-writing the object would let
    // this file describe a configuration `buildConfig` could never produce.
    //
    // The keys are inline and read back out of `config.paystack.secretKey` below
    // rather than shared through a constant: `jest.mock` is hoisted above every
    // `const` in this file, so a factory referencing one would run before it was
    // initialised. Reading the key back is also the honest direction — the suite
    // signs with whatever key the service will verify with.
    config: actual.buildConfig({
      ...process.env,
      PAYSTACK_SECRET_KEY: 'sk_test_a1b2c3d4e5f60718293a4b5c6d7e8f90',
      PAYSTACK_PUBLIC_KEY: 'pk_test_a1b2c3d4e5f60718293a4b5c6d7e8f90',
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

jest.mock('../repositories/sales.repository', () => ({
  findSalePaymentByReference: jest.fn(),
}));

// `sales.service` is mocked here and deliberately not mocked in
// `sales.routes.test.ts`. The two suites are answering different questions:
// that one asks whether the route, the service and the repository agree, so it
// mocks only the SQL. This one asks whether the gateway module believes the
// right things, and its answers about a tender are `sales.service`'s business —
// running the real one would make every assertion below depend on a basket, a
// batch and a settlement as well.
jest.mock('../services/sales.service', () => ({
  applyPaymentOutcome: jest.fn(),
  getPayment: jest.fn(),
}));

import { createHmac } from 'node:crypto';

import { config } from '../config';
import { poolSql, withTransaction } from '../database/pool';
import { findSalePaymentByReference } from '../repositories/sales.repository';
import {
  confirmCharge,
  handleChargeSuccess,
  PAYSTACK_WEBHOOK_PATH,
  readChargeSuccess,
  verifyTransaction,
  webhookSignatureIsValid,
} from '../services/paystack.service';
import { applyPaymentOutcome, getPayment } from '../services/sales.service';
import type {
  SaleItemBatchRow,
  SaleItemRow,
  SalePaymentRow,
  SaleRow,
} from '../repositories/sales.repository';
import type { SaleStatus } from '../utils/schema-enums';

/**
 * Believing as little of a payment gateway as possible.
 *
 * Three guarantees live in this module and nowhere else, and each one fails in
 * a way that looks like success:
 *
 * - **The signature is over the raw bytes.** Verify a re-serialised body and the
 *   check still passes in every test anybody thinks to write, then fails on one
 *   payload in a hundred in production — indistinguishable from an attack, and
 *   fixed by disabling the check.
 * - **A status the gateway reports that is not unambiguously paid or unpaid is
 *   left alone.** Resolving it in whichever direction is convenient marks a
 *   customer's money as failed with nothing on the screen to say so.
 * - **The amount is compared.** The signature proves the body came from Paystack
 *   and was not edited. It does not prove the charge it describes is the one
 *   this tender was written for.
 *
 * What is *not* tested here is the derivation of `configured` and `mode` — that
 * is `config.test.ts`, and repeating it would mean two suites to keep in step
 * about one rule.
 *
 * ## The amount check appears twice below, and that is not duplication
 *
 * `confirmCharge` and `handleChargeSuccess` each make it independently, over a
 * figure that arrives from a different direction. Removing one leaves the other
 * green: the two tests were confirmed to fail separately by disabling each check
 * in turn, so a reader who is tempted to delete one as a repeat should know that
 * the pair is the point. The webhook is the path that runs unattended, and the
 * retry is the path an operator presses — a check that only existed on one would
 * leave the other settling a sale on somebody else's money.
 */

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const SALE = 'a0000000-0000-4000-8000-000000000030';
const PAYMENT = 'a0000000-0000-4000-8000-000000000050';
const SALE_NUMBER = 'H3-000042';
const REFERENCE = `${SALE_NUMBER}-0A1B2C3D4E5F6071`;
const NOW = '2026-09-04T09:20:00.000Z';
const CREATED_AT = '2026-09-04T09:12:00.000Z';

const findPaymentByReferenceMock = jest.mocked(findSalePaymentByReference);
const applyPaymentOutcomeMock = jest.mocked(applyPaymentOutcome);
const getPaymentMock = jest.mocked(getPayment);
const withTransactionMock = jest.mocked(withTransaction);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function saleRow(overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    id: SALE,
    pharmacyId: PHARMACY,
    saleNumber: SALE_NUMBER,
    status: 'pending',
    servedBy: 'a0000000-0000-4000-8000-000000000002',
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

function saleItem(overrides: Partial<SaleItemRow> = {}): SaleItemRow {
  return {
    id: 'a0000000-0000-4000-8000-000000000031',
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
    ...overrides,
  };
}

function saleItemBatch(overrides: Partial<SaleItemBatchRow> = {}): SaleItemBatchRow & {
  inventoryId: string;
} {
  return {
    id: 'a0000000-0000-4000-8000-000000000032',
    saleItemId: 'a0000000-0000-4000-8000-000000000031',
    batchId: 'a0000000-0000-4000-8000-000000000020',
    lotNumber: 'LOT-1',
    quantity: 2,
    unitCost: '8.2500',
    inventoryId: 'a0000000-0000-4000-8000-000000000010',
    ...overrides,
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

/** What `findSalePayment` and `findSalePaymentByReference` both return. */
function tenderWithSale(
  overrides: Partial<SalePaymentRow> = {},
  saleStatus: SaleStatus = 'pending'
): SalePaymentRow & { pharmacyId: string; saleStatus: SaleStatus } {
  return { ...paymentRow(overrides), pharmacyId: PHARMACY, saleStatus };
}

function saleDetail(overrides: Partial<SaleRow> = {}) {
  return {
    sale: saleRow(overrides),
    items: [saleItem()],
    batches: [saleItemBatch()],
    payments: [paymentRow({ status: 'succeeded', paidAt: NOW })],
    servedByName: 'Beatrice Owusu',
    approvedByName: null,
  };
}

// ---------------------------------------------------------------------------
// The gateway boundary
// ---------------------------------------------------------------------------

/**
 * The three fields `callGateway` reads off a `Response`.
 *
 * Cast rather than built with the real `Response`, because constructing one
 * would make this suite depend on which undici version Node shipped — and the
 * point of the fixture is that nothing else about the response matters. If
 * `callGateway` ever reads a fourth field, `undefined` arrives and a test fails
 * loudly rather than passing on a fixture that happens to look complete.
 */
function httpResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

function envelope(data: Record<string, unknown>): string {
  return JSON.stringify({ status: true, message: 'Verification successful', data });
}

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
const realFetch = globalThis.fetch;

/**
 * Signs exactly these bytes, the way Paystack does.
 *
 * Reading the key back out of `config` rather than restating it is the point: a
 * signature computed against a key the service is not using fails in a way that
 * looks like a bug in the check, and a suite that debugs its own fixture is a
 * suite nobody trusts.
 */
function sign(body: string | Buffer, key: string = config.paystack.secretKey): string {
  return createHmac('sha512', key).update(body).digest('hex');
}

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.fetch = fetchMock;
  getPaymentMock.mockResolvedValue(tenderWithSale());
  applyPaymentOutcomeMock.mockResolvedValue({
    detail: saleDetail(),
    changed: true,
    arrivedAfterVoid: false,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // Restored rather than left: `config` is a module-level singleton, so a suite
  // that flipped `configured` and did not put it back would leave every later
  // test in this file asserting against a gateway that is not there.
  config.paystack.configured = true;
});

/** Runs one block with the gateway unconfigured, the way a bad deployment is. */
function unconfigured(run: () => Promise<void>): Promise<void> {
  config.paystack.configured = false;
  return run();
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

describe('webhookSignatureIsValid', () => {
  it('accepts a signature over the exact bytes that arrived', () => {
    const body = Buffer.from(envelope({ reference: REFERENCE, amount: 2500 }), 'utf8');
    expect(webhookSignatureIsValid(body, sign(body))).toBe(true);
  });

  it('verifies the bytes, not the JSON — whitespace and non-ASCII survive', () => {
    // The centrepiece. Paystack signs what it sent, which is not what
    // `JSON.stringify(req.body)` produces: pretty-printed indentation never
    // round-trips, and `é` arrives as two UTF-8 bytes that a re-serialisation
    // may or may not escape the same way. Both are in this payload on purpose.
    const sent = '{\n  "event": "charge.success",\n  "data": {\n    "reference": "' +
      REFERENCE +
      '",\n    "amount": 2500,\n    "customer": { "name": "Ama Ménsh" }\n  }\n}';
    const raw = Buffer.from(sent, 'utf8');

    expect(webhookSignatureIsValid(raw, sign(raw))).toBe(true);

    // The same JSON, re-serialised: identical once parsed, and refused. This is
    // the assertion that goes red if the check is ever "simplified" to
    // `JSON.stringify(req.body)`, which is the change that makes it fail on one
    // payload in a hundred rather than on every one.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(sent)), 'utf8');
    expect(webhookSignatureIsValid(raw, sign(reserialised))).toBe(false);
    expect(webhookSignatureIsValid(reserialised, sign(raw))).toBe(false);
  });

  it('refuses a signature made with any other key, including the public one', () => {
    const body = Buffer.from(envelope({ reference: REFERENCE }), 'utf8');
    expect(webhookSignatureIsValid(body, sign(body, config.paystack.publicKey))).toBe(false);
    expect(webhookSignatureIsValid(body, sign(body, 'sk_live_not_this_one'))).toBe(false);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('refuses a header that is %s', async (_label, header) => {
    const body = Buffer.from(envelope({ reference: REFERENCE }), 'utf8');
    expect(webhookSignatureIsValid(body, header)).toBe(false);
  });

  it('refuses a wrong-length header rather than throwing', () => {
    // `timingSafeEqual` throws on differing lengths. The length check in front
    // of it is what turns a forger's obvious first attempt — a short string —
    // into a refusal instead of a 500, and a 500 on the webhook path is a
    // Paystack retry loop against a request that was never going to verify.
    const body = Buffer.from(envelope({ reference: REFERENCE }), 'utf8');
    expect(() => webhookSignatureIsValid(body, 'deadbeef')).not.toThrow();
    expect(webhookSignatureIsValid(body, 'deadbeef')).toBe(false);
    expect(webhookSignatureIsValid(body, `${sign(body)}ff`)).toBe(false);
  });

  it('trims the header, because a proxy may pad it', () => {
    const body = Buffer.from(envelope({ reference: REFERENCE }), 'utf8');
    expect(webhookSignatureIsValid(body, ` ${sign(body)}\n`)).toBe(true);
  });

  it('refuses the same signature in upper case', () => {
    // Pinned because this is the one somebody will be tempted to relax at six
    // in the evening with a webhook that is not arriving. The digest is
    // lowercase hex and Paystack sends it lowercase; accepting either case is
    // harmless on its own and is still a change to a signature check, so it
    // should be a deliberate one.
    const body = Buffer.from(envelope({ reference: REFERENCE }), 'utf8');
    expect(webhookSignatureIsValid(body, sign(body).toUpperCase())).toBe(false);
  });

  it('refuses everything while the gateway is unconfigured', () =>
    unconfigured(async () => {
      const body = Buffer.from(envelope({ reference: REFERENCE }), 'utf8');
      // Even a signature this server could have made: with no secret key there
      // is nothing to have made it with, and answering true would mean the check
      // had been reduced to "is the header shaped like a hash".
      expect(webhookSignatureIsValid(body, sign(body, 'sk_test_placeholder'))).toBe(false);
    }));
});

// ---------------------------------------------------------------------------
// Reading a webhook
// ---------------------------------------------------------------------------

describe('readChargeSuccess', () => {
  it('reads the reference, amount and paid_at off a charge.success', () => {
    const body = {
      event: 'charge.success',
      data: { reference: REFERENCE, amount: 2500, paid_at: NOW },
    };
    expect(readChargeSuccess(body)).toEqual({
      reference: REFERENCE,
      amountPesewas: 2500,
      paidAt: NOW,
      // Verbatim, because `sale_payments.gateway_response` is the only evidence
      // there is of what was believed. A reshaped copy would be evidence of
      // what this code thought it saw.
      gatewayResponse: body,
    });
  });

  it.each(['charge.failed', 'transfer.success', 'subscription.create', ''])(
    'ignores %s',
    (event) => {
      expect(
        readChargeSuccess({ event, data: { reference: REFERENCE, amount: 2500 } })
      ).toBeNull();
    }
  );

  it('ignores charge.failed even though it is a real event', () => {
    // Deliberate, and worth stating twice. Marking a tender failed from an event
    // this server cannot interrogate further trades a visible pending sale for
    // an invisible one: the operator can press verify and get an answer that has
    // been checked against the amount, and cannot un-fail a tender.
    expect(
      readChargeSuccess({ event: 'charge.failed', data: { reference: REFERENCE } })
    ).toBeNull();
  });

  it('ignores a charge.success that names no reference', () => {
    expect(readChargeSuccess({ event: 'charge.success', data: { amount: 2500 } })).toBeNull();
    expect(readChargeSuccess({ event: 'charge.success', data: {} })).toBeNull();
    expect(readChargeSuccess({ event: 'charge.success' })).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'charge.success'],
    ['an array', [{ event: 'charge.success' }]],
    ['nothing at all', undefined],
  ])('ignores a body that is %s', (_label, body) => {
    expect(readChargeSuccess(body)).toBeNull();
  });

  it('reports no amount when the gateway sends something that is not an integer', () => {
    // Not coerced. A string `'2500'` is what a gateway sends when it has changed
    // its mind about types, and `Number('2500')` would quietly agree with it —
    // after which the amount check is comparing a figure this server invented.
    // Null means "no amount reported", and the caller then applies the outcome
    // without the comparison; that consequence is pinned in `handleChargeSuccess`
    // below so it is a decision on the record rather than an accident here.
    expect(
      readChargeSuccess({ event: 'charge.success', data: { reference: REFERENCE, amount: '2500' } })
        ?.amountPesewas
    ).toBeNull();
    expect(
      readChargeSuccess({ event: 'charge.success', data: { reference: REFERENCE, amount: 25.5 } })
        ?.amountPesewas
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Asking the gateway
// ---------------------------------------------------------------------------

describe('verifyTransaction', () => {
  it('settles a tender only on success', async () => {
    fetchMock.mockResolvedValue(
      httpResponse(200, envelope({ status: 'success', amount: 2500, paid_at: NOW }))
    );
    await expect(verifyTransaction(REFERENCE)).resolves.toEqual({
      status: 'succeeded',
      amountPesewas: 2500,
      paidAt: NOW,
      gatewayResponse: {
        status: true,
        message: 'Verification successful',
        data: { status: 'success', amount: 2500, paid_at: NOW },
      },
    });
  });

  it.each(['failed', 'abandoned'])('treats %s as failed', async (status) => {
    fetchMock.mockResolvedValue(httpResponse(200, envelope({ status, amount: 2500 })));
    const verdict = await verifyTransaction(REFERENCE);
    expect(verdict.status).toBe('failed');
    // No `paid_at` on a charge that did not complete, even if the gateway offers
    // one: a timestamp on a failed tender is what makes a refund argument
    // unwinnable.
    expect(verdict.paidAt).toBeNull();
  });

  it.each(['pending', 'queued', 'ongoing', 'a_value_added_next_year'])(
    'refuses to guess about %s',
    async (status) => {
      fetchMock.mockResolvedValue(
        httpResponse(200, envelope({ status, amount: 2500, paid_at: NOW }))
      );
      const verdict = await verifyTransaction(REFERENCE);
      expect(verdict.status).toBe('unsettled');
      expect(verdict.paidAt).toBeNull();
    }
  );

  it('reports no amount when the gateway sends one that is not an integer', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, envelope({ status: 'success', amount: '2500' })));
    await expect(verifyTransaction(REFERENCE)).resolves.toMatchObject({
      status: 'succeeded',
      amountPesewas: null,
    });
  });

  it('sends the secret key and encodes the reference into the path', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, envelope({ status: 'success', amount: 2500 })));
    await verifyTransaction('H3-000042/a?b=c d');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.paystack.co/transaction/verify/H3-000042%2Fa%3Fb%3Dc%20d');
    // Without the header Paystack answers 401, which arrives here as
    // `gateway_refused` and reads like a problem with the charge.
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${config.paystack.secretKey}`,
    });
  });

  it('answers 503 without calling out while the gateway is unconfigured', () =>
    unconfigured(async () => {
      await expect(verifyTransaction(REFERENCE)).rejects.toMatchObject({
        status: 503,
        code: 'gateway_unconfigured',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }));

  it('answers 502 when Paystack does not answer at all', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    await expect(verifyTransaction(REFERENCE)).rejects.toMatchObject({
      status: 502,
      code: 'gateway_unreachable',
    });
  });

  it('answers 502 when Paystack answers with something that is not JSON', async () => {
    // A captive portal, a proxy error page and a truncated body all look like
    // this. Reporting it as `gateway_refused` would tell the operator Paystack
    // had considered the charge and said no.
    fetchMock.mockResolvedValue(httpResponse(200, '<html>502 Bad Gateway</html>'));
    await expect(verifyTransaction(REFERENCE)).rejects.toMatchObject({
      status: 502,
      code: 'gateway_bad_response',
    });
  });

  it('carries the gateway message when Paystack refuses', async () => {
    // "Invalid key" is the difference between a five-minute fix and an afternoon
    // of guessing, and it is for an authenticated member of staff about the
    // pharmacy's own account.
    fetchMock.mockResolvedValue(
      httpResponse(401, JSON.stringify({ status: false, message: 'Invalid key' }))
    );
    await expect(verifyTransaction(REFERENCE)).rejects.toMatchObject({
      status: 502,
      code: 'gateway_refused',
      message: 'Paystack refused that request: Invalid key',
    });
  });

  it('treats a 200 carrying status:false as a refusal', async () => {
    fetchMock.mockResolvedValue(
      httpResponse(200, JSON.stringify({ status: false, message: 'Transaction not found' }))
    );
    await expect(verifyTransaction(REFERENCE)).rejects.toMatchObject({
      status: 502,
      code: 'gateway_refused',
    });
  });

  it('still refuses when Paystack sends no message to carry', async () => {
    fetchMock.mockResolvedValue(httpResponse(500, ''));
    await expect(verifyTransaction(REFERENCE)).rejects.toMatchObject({
      status: 502,
      code: 'gateway_refused',
      message: 'Paystack refused that request.',
    });
  });
});

// ---------------------------------------------------------------------------
// The retry path
// ---------------------------------------------------------------------------

describe('confirmCharge', () => {
  it('refuses a cash tender without asking the gateway anything', async () => {
    getPaymentMock.mockResolvedValue(
      tenderWithSale({ method: 'cash', status: 'succeeded', reference: null, paidAt: CREATED_AT })
    );
    await expect(confirmCharge(PHARMACY, PAYMENT, NOW)).rejects.toMatchObject({
      status: 400,
      code: 'payment_not_gateway',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyPaymentOutcomeMock).not.toHaveBeenCalled();
  });

  it('refuses a mobile money tender that has no reference to ask about', async () => {
    getPaymentMock.mockResolvedValue(tenderWithSale({ reference: null }));
    await expect(confirmCharge(PHARMACY, PAYMENT, NOW)).rejects.toMatchObject({
      status: 409,
      code: 'payment_has_no_reference',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes nothing at all when the gateway will not say either way', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, envelope({ status: 'pending', amount: 2500 })));

    await expect(confirmCharge(PHARMACY, PAYMENT, NOW)).resolves.toEqual({
      detail: null,
      changed: false,
      arrivedAfterVoid: false,
      unsettled: true,
    });
    // The assertion that matters. Every other branch here writes something;
    // this one must not, because a tender wrongly moved to `failed` is a
    // customer's money missing from the record with nothing on the screen to
    // say so.
    expect(applyPaymentOutcomeMock).not.toHaveBeenCalled();
  });

  it('refuses to settle a charge for a different amount', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, envelope({ status: 'success', amount: 2400 })));

    await expect(confirmCharge(PHARMACY, PAYMENT, NOW)).rejects.toMatchObject({
      status: 409,
      code: 'gateway_amount_mismatch',
      details: { expected: 2500, reported: 2400 },
    });
    expect(applyPaymentOutcomeMock).not.toHaveBeenCalled();
  });

  it('applies a charge whose amount matches, and carries no reference back', async () => {
    fetchMock.mockResolvedValue(
      httpResponse(200, envelope({ status: 'success', amount: 2500, paid_at: NOW }))
    );

    const result = await confirmCharge(PHARMACY, PAYMENT, NOW);

    expect(result).toMatchObject({ changed: true, arrivedAfterVoid: false, unsettled: false });
    // Asserted against the whole outcome object, not `toMatchObject`, and that is
    // doing work: an extra key fails this. The runtime half of a decision the
    // types already make — `PaymentOutcome` has no `reference`, because the only
    // reference worth carrying back is the one this server asked about, and
    // writing it onto the tender would replace the one value a later webhook has
    // to find that tender with.
    expect(applyPaymentOutcomeMock).toHaveBeenCalledWith(
      PHARMACY,
      PAYMENT,
      {
        status: 'succeeded',
        paidAt: NOW,
        gatewayResponse: {
          status: true,
          message: 'Verification successful',
          data: { status: 'success', amount: 2500, paid_at: NOW },
        },
      },
      NOW
    );
  });

  it('applies a charge the gateway reports with no amount at all', async () => {
    // The consequence of `readChargeSuccess` refusing to coerce. Pinned here
    // rather than left implicit: a success with no readable amount is applied,
    // because refusing it would leave a customer who has paid with a pending
    // sale nobody can clear from the till. The mismatch check only has teeth
    // when there is a figure to compare.
    fetchMock.mockResolvedValue(httpResponse(200, envelope({ status: 'success', amount: '2500' })));

    await expect(confirmCharge(PHARMACY, PAYMENT, NOW)).resolves.toMatchObject({
      changed: true,
      unsettled: false,
    });
    expect(applyPaymentOutcomeMock).toHaveBeenCalled();
  });

  it('passes through that the money arrived against a voided sale', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, envelope({ status: 'success', amount: 2500 })));
    applyPaymentOutcomeMock.mockResolvedValue({
      detail: saleDetail({ status: 'voided' }),
      changed: true,
      arrivedAfterVoid: true,
    });

    // Not an error and not something to fix by un-voiding: the sale is cancelled
    // and the receipt says so, the wallet was debited, and this build has no
    // refund flow. Both facts stay visible.
    await expect(confirmCharge(PHARMACY, PAYMENT, NOW)).resolves.toMatchObject({
      arrivedAfterVoid: true,
      unsettled: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The webhook path
// ---------------------------------------------------------------------------

describe('handleChargeSuccess', () => {
  function webhook(reference: string, amount: unknown = 2500): unknown {
    return { event: 'charge.success', data: { reference, amount, paid_at: NOW } };
  }

  it('acknowledges an event that is not ours without looking anything up', async () => {
    await expect(handleChargeSuccess({ event: 'transfer.success' }, NOW)).resolves.toEqual({
      reason: 'not_our_event',
      handled: false,
      arrivedAfterVoid: false,
    });
    expect(findPaymentByReferenceMock).not.toHaveBeenCalled();
  });

  it('acknowledges a reference this server never issued', async () => {
    findPaymentByReferenceMock.mockResolvedValue(null);

    await expect(handleChargeSuccess(webhook('H9-999999-FFFFFFFFFFFFFFFF'), NOW)).resolves.toEqual({
      reason: 'unknown_reference',
      handled: false,
      arrivedAfterVoid: false,
    });
    expect(applyPaymentOutcomeMock).not.toHaveBeenCalled();
  });

  it('acknowledges an amount that does not match, and writes nothing', async () => {
    findPaymentByReferenceMock.mockResolvedValue(tenderWithSale());

    // 200 to Paystack, because a retry cannot make two figures agree — refusing
    // would only bury the log line under retries of the same mismatch.
    await expect(handleChargeSuccess(webhook(REFERENCE, 9999), NOW)).resolves.toEqual({
      reason: 'amount_mismatch',
      handled: false,
      arrivedAfterVoid: false,
    });
    expect(applyPaymentOutcomeMock).not.toHaveBeenCalled();
  });

  it('applies the outcome to the pharmacy the row belongs to, not to an argument', async () => {
    findPaymentByReferenceMock.mockResolvedValue(tenderWithSale());

    await expect(handleChargeSuccess(webhook(REFERENCE), NOW)).resolves.toEqual({
      reason: 'applied',
      handled: true,
      arrivedAfterVoid: false,
    });

    // A webhook carries no tenant: Paystack knows the account, not the pharmacy.
    // The reference finds exactly one row, and that row brings its own
    // `pharmacy_id` back — which is the whole reason the reference is minted
    // server-side and never accepted from a caller.
    expect(findPaymentByReferenceMock).toHaveBeenCalledWith(poolSql, REFERENCE);
    expect(applyPaymentOutcomeMock).toHaveBeenCalledWith(
      PHARMACY,
      PAYMENT,
      { status: 'succeeded', paidAt: NOW, gatewayResponse: webhook(REFERENCE) },
      NOW
    );
  });

  it('reports a tender that was already terminal as recorded, not as applied', async () => {
    findPaymentByReferenceMock.mockResolvedValue(
      tenderWithSale({ status: 'succeeded', paidAt: CREATED_AT })
    );
    applyPaymentOutcomeMock.mockResolvedValue({
      detail: saleDetail(),
      changed: false,
      arrivedAfterVoid: false,
    });

    // `handled: false` is what stops a redelivery from looking like a second
    // payment in the log.
    await expect(handleChargeSuccess(webhook(REFERENCE), NOW)).resolves.toEqual({
      reason: 'already_recorded',
      handled: false,
      arrivedAfterVoid: false,
    });
  });

  it('passes through that the money arrived against a voided sale', async () => {
    findPaymentByReferenceMock.mockResolvedValue(tenderWithSale({}, 'voided'));
    applyPaymentOutcomeMock.mockResolvedValue({
      detail: saleDetail({ status: 'voided' }),
      changed: true,
      arrivedAfterVoid: true,
    });

    await expect(handleChargeSuccess(webhook(REFERENCE), NOW)).resolves.toMatchObject({
      reason: 'applied',
      handled: true,
      arrivedAfterVoid: true,
    });
  });

  it('routes on a plain read and leaves the transaction to the write', async () => {
    findPaymentByReferenceMock.mockResolvedValue(tenderWithSale());

    await handleChargeSuccess(webhook(REFERENCE), NOW);

    // The lookup only decides *which* tender the event is about.
    // `applyPaymentOutcome` re-reads the tender and locks the sale inside its own
    // transaction, so a webhook and a `verify` arriving together still serialise
    // on the row that matters — and a webhook holding a transaction open across
    // a network it does not control would hold it open across nothing at all.
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The mount point
// ---------------------------------------------------------------------------

describe('PAYSTACK_WEBHOOK_PATH', () => {
  it('is the one path three separate places have to agree on', () => {
    // `routes/index.ts` mounts the router at it and lists it in
    // `PUBLIC_ROUTE_PREFIXES`; `app.ts` keeps the raw body aside for it and
    // exempts it from rate limiting. All four read this constant, so they cannot
    // drift — and this assertion is what fails if somebody inlines the string in
    // one of them.
    expect(PAYSTACK_WEBHOOK_PATH).toBe('/webhooks/paystack');
  });
});
