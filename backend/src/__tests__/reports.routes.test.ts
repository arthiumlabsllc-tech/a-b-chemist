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

jest.mock('../repositories/reports.repository', () => ({
  // The repository is mocked and the service deliberately is not, so what these
  // tests exercise is the path a request actually travels: the pagination chain,
  // the two `isDate` rules, the authorisation at the mount, the service's window
  // resolution and the bundle it assembles. Mocking the service would assert the
  // route against a stub that agrees with the test, and the assertion that matters
  // most below — that a reversed range arrives as a 400 with a sentence rather
  // than as eight scans of an empty window — would be about nothing.
  reportDaily: jest.fn(),
  reportDrawer: jest.fn(),
  reportProductProfit: jest.fn(),
  reportProfitTotals: jest.fn(),
  reportStaff: jest.fn(),
  reportStatusTotals: jest.fn(),
  reportTenders: jest.fn(),
  reportVat: jest.fn(),
}));

import request from 'supertest';
import { createApp } from '../app';
import {
  reportDaily,
  reportDrawer,
  reportProductProfit,
  reportProfitTotals,
  reportStaff,
  reportStatusTotals,
  reportTenders,
  reportVat,
  type DailyRow,
  type DrawerRow,
  type ProductProfitRow,
  type ProfitTotalRow,
  type StaffRow,
  type StatusTotalRow,
  type TenderRow,
  type VatRow,
} from '../repositories/reports.repository';
import { findUserById, type UserRow } from '../repositories/users.repository';
import { signAccessToken } from '../utils/jwt';
import type { UserRole } from '../utils/permissions';

/**
 * Reports, over HTTP.
 *
 * The permission split is the thing under test. `reports:read` is held by the
 * owner and the pharmacist and not by counter staff, and the reason is not a
 * hierarchy: a report carries the gross margin, the cost of goods and the till
 * voids per person. There is no weaker half of it that a cashier could be given,
 * which is why the mount authorises once rather than per route — and why the 403
 * is asserted here rather than left to `route-protection.test.ts`, which proves
 * the route is behind *a* permission and not that it is behind this one.
 *
 * The second thing worth proving at this level is that a bad range is refused
 * before the first aggregate is issued. Eight scans of an unbounded window is the
 * expensive half of a malformed request, and the difference between a 400 and a
 * pool connection held for as long as a full scan takes is invisible in the
 * service's own suite.
 */

const app = createApp();

const findUserByIdMock = findUserById as jest.Mock;

const ALL_MOCKS: jest.Mock[] = [
  reportStatusTotals as jest.Mock,
  reportDaily as jest.Mock,
  reportProfitTotals as jest.Mock,
  reportProductProfit as jest.Mock,
  reportStaff as jest.Mock,
  reportTenders as jest.Mock,
  reportDrawer as jest.Mock,
  reportVat as jest.Mock,
];

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PHARMACY = 'b0000000-0000-4000-8000-000000000009';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const CASHIER_ID = 'a0000000-0000-4000-8000-000000000004';
const STORED_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS';

/** Five days, so both bounds and the day count are exercised. */
const FROM = '2026-09-01';
const TO = '2026-09-05';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

let users: Record<string, UserRow>;

function user(id: string, role: UserRole): UserRow {
  return {
    id,
    pharmacyId: PHARMACY,
    fullName: role,
    email: `${id}@aandb.example`,
    phone: null,
    role,
    passwordHash: STORED_HASH,
    isActive: true,
    sessionVersion: 2,
    lastLoginAt: null,
  };
}

function tokenFor(id: string, role: UserRole): string {
  return signAccessToken({ userId: id, pharmacyId: PHARMACY, role, sessionVersion: 2 });
}

const ownerToken = (): string => tokenFor(OWNER_ID, 'pharmacy_owner');
const pharmacistToken = (): string => tokenFor(PHARMACIST_ID, 'pharmacist');
const cashierToken = (): string => tokenFor(CASHIER_ID, 'staff');

function statusRow(overrides: Partial<StatusTotalRow> = {}): StatusTotalRow {
  return {
    status: 'completed',
    saleCount: 12,
    subtotal: '1000.00',
    discount: '20.00',
    vatAmount: '0.00',
    nhilAmount: '0.00',
    getfundAmount: '0.00',
    taxTotal: '0.00',
    total: '980.00',
    averageTotal: '81.67',
    patientSaleCount: 3,
    ...overrides,
  };
}

const EMPTY_PROFIT: ProfitTotalRow = {
  lineCount: 0,
  lineRevenue: '0.00',
  costOfGoods: '0.00',
  grossProfit: '0.00',
  grossMarginPercent: null,
  zeroCostLines: 0,
};

/**
 * One row per multi-row section, typed as the row rather than cast to it: if a
 * section grows a field this file stops compiling instead of quietly answering
 * with something no repository would return, and a route test that fed the
 * service a short row would be asserting the envelope against a fiction.
 */
const DAILY_ROW: DailyRow = {
  day: '2026-09-03',
  saleCount: 4,
  revenue: '210.00',
  discount: '5.00',
  taxTotal: '0.00',
  costOfGoods: '140.00',
  grossProfit: '70.00',
};

const PROFIT_ROW: ProfitTotalRow = {
  ...EMPTY_PROFIT,
  lineCount: 20,
  lineRevenue: '980.00',
  costOfGoods: '600.00',
  grossProfit: '380.00',
  grossMarginPercent: '38.8',
};

const PRODUCT_ROW: ProductProfitRow = {
  productId: 'a0000000-0000-4000-8000-000000000010',
  name: 'Paracetamol 500mg',
  lineCount: 6,
  baseUnits: 60,
  revenue: '120.00',
  costOfGoods: '72.00',
  grossProfit: '48.00',
  grossMarginPercent: '40.0',
  zeroCostLines: 0,
};

const STAFF_ROW: StaffRow = {
  userId: PHARMACIST_ID,
  fullName: 'Ama Mensah',
  role: 'pharmacist',
  saleCount: 8,
  revenue: '640.00',
  discount: '10.00',
  pendingCount: 1,
  voidedCount: 0,
};

const TENDER_ROWS: TenderRow[] = [
  {
    method: 'cash',
    settledCount: 9,
    settledAmount: '700.00',
    unsettledCount: 0,
    unsettledAmount: '0.00',
  },
  {
    method: 'momo',
    settledCount: 3,
    settledAmount: '280.00',
    unsettledCount: 0,
    unsettledAmount: '0.00',
  },
];

const DRAWER_ROW: DrawerRow = {
  cashTaken: '750.00',
  changeGiven: '50.00',
  cashRetained: '700.00',
};

const VAT_ROW: VatRow = {
  treatment: 'exempt',
  lineCount: 20,
  taxableBase: '980.00',
  gross: '1000.00',
  discount: '20.00',
  vatAmount: '0.00',
  nhilAmount: '0.00',
  getfundAmount: '0.00',
  lineTotal: '980.00',
};

interface ErrorBody {
  success: false;
  /**
   * `unknown` rather than one of the two shapes, because both arrive here and
   * both are correct: a list of `{ field, message }` from validation and
   * `{ missing: [...] }` from `authorize`. Typing it as one would make the other
   * assertion a cast, and a cast in a test is an assertion nobody checks.
   */
  error: { message: string; code?: string; details?: unknown };
}

function errorOf(body: unknown): ErrorBody {
  return body as ErrorBody;
}

function get(token: string | undefined, queryString = ''): request.Test {
  const test = request(app).get(`/reports/sales${queryString}`);
  if (token !== undefined) test.set('Authorization', `Bearer ${token}`);
  return test;
}

beforeEach(() => {
  jest.clearAllMocks();
  users = {
    [OWNER_ID]: user(OWNER_ID, 'pharmacy_owner'),
    [PHARMACIST_ID]: user(PHARMACIST_ID, 'pharmacist'),
    [CASHIER_ID]: user(CASHIER_ID, 'staff'),
  };
  findUserByIdMock.mockImplementation(async (id: string) => users[id] ?? null);

  // A window with one row in every multi-row section, so a section that arrives
  // empty because the route dropped it is visible rather than indistinguishable
  // from a quiet day.
  (reportStatusTotals as jest.Mock).mockResolvedValue([statusRow()]);
  (reportDaily as jest.Mock).mockResolvedValue([DAILY_ROW]);
  (reportProfitTotals as jest.Mock).mockResolvedValue(PROFIT_ROW);
  (reportProductProfit as jest.Mock).mockResolvedValue([PRODUCT_ROW]);
  (reportStaff as jest.Mock).mockResolvedValue([STAFF_ROW]);
  (reportTenders as jest.Mock).mockResolvedValue(TENDER_ROWS);
  (reportDrawer as jest.Mock).mockResolvedValue(DRAWER_ROW);
  (reportVat as jest.Mock).mockResolvedValue([VAT_ROW]);
});

describe('who may read a report', () => {
  it('answers the owner and the pharmacist', async () => {
    for (const [role, token] of [
      ['pharmacy_owner', ownerToken()],
      ['pharmacist', pharmacistToken()],
    ] as [UserRole, string][]) {
      const response = await get(token, `?from=${FROM}&to=${TO}`);
      expect({ role, status: response.status }).toEqual({ role, status: 200 });
    }
  });

  it('refuses counter staff with a 403, because the margin is in the response', async () => {
    const response = await get(cashierToken(), `?from=${FROM}&to=${TO}`);
    const body = errorOf(response.body);

    // 403 and not 401: a cashier is authenticated, and telling them otherwise
    // would send them to sign in again rather than to ask the owner.
    expect(response.status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.details).toEqual({ missing: ['reports:read'] });
  });

  it('does no work at all for a role that may not read one', async () => {
    await get(cashierToken(), `?from=${FROM}&to=${TO}`);
    // Authorisation runs at the mount, before the handler, so a refused cashier
    // leaves no aggregate behind. A report is eight scans; running them and
    // throwing the answer away would be the expensive way to say no.
    for (const mock of ALL_MOCKS) expect(mock).not.toHaveBeenCalled();
  });

  it('refuses a request with no token, and one with a token for a user who is gone', async () => {
    expect((await get(undefined)).status).toBe(401);

    users = {};
    expect((await get(ownerToken())).status).toBe(401);
    for (const mock of ALL_MOCKS) expect(mock).not.toHaveBeenCalled();
  });
});

describe('the bundle that comes back', () => {
  it('arrives in the one envelope, with the report and the page it was cut to beside each other', async () => {
    const response = await get(ownerToken(), `?from=${FROM}&to=${TO}`);

    expect(response.body.success).toBe(true);
    expect(response.body.data.limit).toBe(50);
    expect(response.body.data.offset).toBe(0);
    // Advertised beside the report rather than buried in it, so the date picker
    // cannot offer a range the API will refuse.
    expect(response.body.data.maxRangeDays).toBe(366);
    expect(response.body.data.report.range).toEqual({ from: FROM, to: TO });
  });

  it('carries every section, including the ones the window had none of', async () => {
    const response = await get(ownerToken(), `?from=${FROM}&to=${TO}`);
    const report = response.body.data.report;

    // All five statuses and all three VAT treatments whether or not the window
    // held any. A section that is empty because it was dropped and one that is
    // empty because nothing happened are the same JSON, and only the zero-filling
    // tells them apart.
    expect(report.byStatus).toHaveLength(5);
    expect(report.tenders).toHaveLength(2);
    expect(report.vat).toHaveLength(3);
    expect(report.summary.revenue).toBe('980.00');
    expect(report.profitability.grossProfit).toBe('380.00');
    expect(report.drawer.cashRetained).toBe('700.00');
    expect(report.daily).toHaveLength(1);
    expect(report.staff).toHaveLength(1);
    expect(DATE_ONLY.test(report.range.from)).toBe(true);
  });

  it('stamps the bundle with the moment it was assembled, so a cached copy can say how old it is', async () => {
    const response = await get(ownerToken(), `?from=${FROM}&to=${TO}`);
    const before = Date.now();
    const generatedAt = Date.parse(response.body.data.report.generatedAt as string);

    expect(Number.isNaN(generatedAt)).toBe(false);
    expect(generatedAt).toBeLessThanOrEqual(before);
    expect(generatedAt).toBeGreaterThan(before - 60_000);
  });

  it('reads the pharmacy from the token, and ignores one sent as a parameter', async () => {
    // The token carries the pharmacy, so the id is never taken from the request.
    // A route that read it from a query parameter would let any authenticated user
    // read any pharmacy's margin, and this build having one tenant is not a reason
    // to leave the door shaped that way.
    await get(ownerToken(), `?from=${FROM}&to=${TO}&pharmacyId=${OTHER_PHARMACY}`);

    for (const mock of ALL_MOCKS) {
      expect(mock.mock.calls[0]?.[1]).toBe(PHARMACY);
      expect(mock.mock.calls[0]?.[1]).not.toBe(OTHER_PHARMACY);
    }
  });

  it('hands the same window to all eight reads', async () => {
    // One endpoint rather than five, so five sections cannot be asked about five
    // different ranges. A page showing takings from Tuesday and a VAT return from
    // Monday is not obviously wrong; it is just wrong.
    await get(ownerToken(), `?from=${FROM}&to=${TO}`);

    expect(ALL_MOCKS).toHaveLength(8);
    for (const mock of ALL_MOCKS) {
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0]?.[2]).toEqual({ from: FROM, to: TO });
    }
  });
});

describe('the window the caller asked for', () => {
  it('defaults both ends to today when neither is sent, rather than to a month', async () => {
    const response = await get(ownerToken());
    const range = response.body.data.report.range as { from: string; to: string };

    // A report that opened on the last thirty days would answer a question nobody
    // asked and take thirty times the scan to do it.
    expect(range.from).toEqual(range.to);
    expect(DATE_ONLY.test(range.from)).toBe(true);
  });

  it('fills one end when only the other is sent', async () => {
    const response = await get(ownerToken(), `?from=${FROM}`);
    const range = response.body.data.report.range as { from: string; to: string };

    expect(range.from).toBe(FROM);
    expect(DATE_ONLY.test(range.to)).toBe(true);
  });

  it('treats a cleared picker cell as no window at all, rather than as a refusal', async () => {
    const response = await get(ownerToken(), '?from=&to=');

    // Both ends default to today, exactly as when neither is sent. Clearing a date
    // picker sends `?from=&to=`, and `.isDate()` refuses an empty string unless the
    // chain says `{ values: 'falsy' }` — so this was a 400 on the report page the
    // moment anybody reset the range, which reads as "the report is broken" rather
    // than as "pick a date", and it happened on the one router whose two filters
    // are both dates so there was no accepted neighbour to compare it with.
    expect(response.status).toBe(200);
    const range = response.body.data.report.range as { from: string; to: string };
    expect(range.from).toEqual(range.to);
    expect(DATE_ONLY.test(range.from)).toBe(true);
  });

  it('turns a malformed date into a sentence naming the field, not into a 500', async () => {
    for (const queryString of [`?from=2026-9-1&to=${TO}`, `?from=${FROM}&to=05/09/2026`]) {
      const response = await get(ownerToken(), queryString);
      const body = errorOf(response.body);

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('validation_failed');
      expect(body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: queryString.includes('from=2026-9-1') ? 'from' : 'to',
            message: expect.stringContaining('YYYY-MM-DD'),
          }),
        ])
      );
      // Refused at the validator, so nothing scanned.
      for (const mock of ALL_MOCKS) expect(mock).not.toHaveBeenCalled();
    }
  });

  it('refuses a reversed range before issuing a single aggregate', async () => {
    const response = await get(ownerToken(), `?from=${TO}&to=${FROM}`);
    const body = errorOf(response.body);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_range');
    expect(body.error.message).toContain(TO);
    expect(body.error.message).toContain(FROM);
    for (const mock of ALL_MOCKS) expect(mock).not.toHaveBeenCalled();
  });

  it('refuses a range one day wider than the ceiling it advertises', async () => {
    // 366 inclusive days is the widest window; 2026-01-01 to 2027-01-02 is 367.
    const response = await get(ownerToken(), '?from=2026-01-01&to=2027-01-02');
    const body = errorOf(response.body);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('range_too_wide');
    expect(body.error.message).toContain('366');
    expect(body.error.message).toContain('367');
    for (const mock of ALL_MOCKS) expect(mock).not.toHaveBeenCalled();
  });

  it('accepts the widest window it advertises', async () => {
    const response = await get(ownerToken(), '?from=2026-01-01&to=2027-01-01');
    expect(response.status).toBe(200);
    expect(ALL_MOCKS.every((mock) => mock.mock.calls.length === 1)).toBe(true);
  });
});

describe('the page the product list is cut to', () => {
  it('echoes limit and offset, and hands them to the product read alone', async () => {
    const response = await get(ownerToken(), `?from=${FROM}&to=${TO}&limit=20&offset=40`);

    expect(response.body.data.limit).toBe(20);
    expect(response.body.data.offset).toBe(40);
    expect(response.body.data.report.profitability.limit).toBe(20);
    expect(response.body.data.report.profitability.offset).toBe(40);
    expect(reportProductProfit).toHaveBeenCalledWith(
      expect.anything(),
      PHARMACY,
      { from: FROM, to: TO },
      20,
      40
    );
    // Every other section is bounded by something other than the data: five
    // statuses, three treatments, two tenders, one row per day. Paging one of
    // them would be a report that silently omits a line.
    for (const mock of ALL_MOCKS) {
      if (mock === (reportProductProfit as jest.Mock)) continue;
      expect(mock.mock.calls[0]).toHaveLength(3);
    }
  });

  it('says there is another page only when the page came back full', async () => {
    (reportProductProfit as jest.Mock).mockResolvedValue(new Array(20).fill(PRODUCT_ROW));

    const full = await get(ownerToken(), `?from=${FROM}&to=${TO}&limit=20`);
    expect(full.body.data.report.profitability.hasMoreProducts).toBe(true);

    const short = await get(ownerToken(), `?from=${FROM}&to=${TO}&limit=21`);
    expect(short.body.data.report.profitability.hasMoreProducts).toBe(false);
  });

  it('refuses a limit outside the shared bounds, with the bound named', async () => {
    const response = await get(ownerToken(), `?from=${FROM}&to=${TO}&limit=201`);
    const body = errorOf(response.body);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'limit', message: expect.stringContaining('200') }),
      ])
    );
    for (const mock of ALL_MOCKS) expect(mock).not.toHaveBeenCalled();
  });
});

describe('what the route is not', () => {
  it('has no write verb, because a report that could be corrected would be a second set of books', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(app)[method]('/reports/sales').set(
        'Authorization',
        `Bearer ${ownerToken()}`
      );
      expect({ method, status: response.status }).toEqual({ method, status: 404 });
    }
    for (const mock of ALL_MOCKS) expect(mock).not.toHaveBeenCalled();
  });

  it('answers a database failure with a 500 in the envelope, not with an empty report', async () => {
    (reportDrawer as jest.Mock).mockRejectedValue(new Error('connection terminated'));

    const response = await get(ownerToken(), `?from=${FROM}&to=${TO}`);
    const body = errorOf(response.body);

    // An empty report and a failed one look identical on the page unless the
    // failure travels, and "no sales today" is the one thing a report must not say
    // by accident. That the driver's own message is withheld from the browser is
    // `error.middleware.test.ts`: it turns on `config.isProduction`, which
    // `jest.setup.js` pins false for every suite, so the raw message arriving here
    // is the correct answer and not a leak.
    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('internal_error');
    // The bundle is not there at all, rather than there with zeros in it.
    expect(response.body.data).toBeUndefined();
  });
});
