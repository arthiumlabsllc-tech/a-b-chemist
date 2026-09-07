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

jest.mock('../repositories/tax-settings.repository', () => ({
  // The repository is mocked and the service and the shared engine are not, so
  // what these tests exercise is the whole path an owner's keystrokes actually
  // travel: express-validator, the authorisation middleware, the service's fault
  // collection and the engine's own refusal. Mocking the service would test the
  // route against a stub that agrees with the test, and the assertion that
  // matters most below — that a malformed rate reaches the browser as a 400 with
  // a field the form can point at — would be about nothing.
  readTaxSettings: jest.fn(),
  writeTaxSettings: jest.fn(),
}));

import request from 'supertest';
import { createApp } from '../app';
import {
  readTaxSettings,
  writeTaxSettings,
  type TaxSettingsRow,
  type TaxSettingsWrite,
} from '../repositories/tax-settings.repository';
import { findUserById, type UserRow } from '../repositories/users.repository';
import { HttpError } from '../utils/http';
import { signAccessToken } from '../utils/jwt';
import type { UserRole } from '../utils/permissions';

/**
 * Tax settings, over HTTP.
 *
 * The permission split is the thing under test. Every role that can sell can
 * read the rates, because a till cannot price a basket without them and Phase
 * 9's offline till cannot function at all without caching them; only the owner
 * can change them, because that half decides what every sale in the pharmacy
 * charges. Two routes one path apart, answering to different roles, is exactly
 * the shape that goes wrong when somebody tidies the mount table — so both
 * halves are asserted for all three roles rather than the interesting one only.
 */

const app = createApp();

const readMock = readTaxSettings as jest.Mock;
const writeMock = writeTaxSettings as jest.Mock;
const findUserByIdMock = findUserById as jest.Mock;

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const CASHIER_ID = 'a0000000-0000-4000-8000-000000000004';
const STORED_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS';
const UPDATED_AT = '2026-09-01T08:00:00.000Z';

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

function stored(overrides: Partial<TaxSettingsRow> = {}): TaxSettingsRow {
  return {
    pharmacyId: PHARMACY,
    taxInclusivePricing: true,
    vatRate: '0.1500',
    nhilRate: '0.0250',
    getfundRate: '0.0250',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

/** Act 1151, exactly as the settings form would post it. */
const VALID_BODY = {
  taxInclusivePricing: true,
  vatRate: '0.1500',
  nhilRate: '0.0250',
  getfundRate: '0.0250',
};

function call(
  method: 'get' | 'put',
  token: string | undefined,
  body?: object
): request.Test {
  const agent = request(app);
  const test = method === 'get' ? agent.get('/tax/settings') : agent.put('/tax/settings');
  if (token !== undefined) test.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) test.send(body);
  return test;
}

interface ErrorBody {
  success: false;
  /**
   * `unknown` rather than the field-error array, because two shapes arrive here
   * and both are correct: a list of `{ field, message }` from validation, and
   * `{ missing: [...] }` from `authorize`. Typing it as one would make the
   * other assertion a cast, and a cast in a test is an assertion nobody checks.
   */
  error: { message: string; code?: string; details?: unknown };
}

function errorOf(body: unknown): ErrorBody {
  return body as ErrorBody;
}

beforeEach(() => {
  jest.clearAllMocks();
  users = {
    [OWNER_ID]: user(OWNER_ID, 'pharmacy_owner'),
    [PHARMACIST_ID]: user(PHARMACIST_ID, 'pharmacist'),
    [CASHIER_ID]: user(CASHIER_ID, 'staff'),
  };
  findUserByIdMock.mockImplementation(async (id: string) => users[id] ?? null);
  readMock.mockResolvedValue(stored());
  writeMock.mockImplementation(
    async (_pharmacyId: string, write: TaxSettingsWrite) => stored({ ...write })
  );
});

describe('GET /tax/settings', () => {
  it('answers every role that can sell, because a till cannot price without the rates', async () => {
    for (const [role, token] of [
      ['pharmacy_owner', ownerToken()],
      ['pharmacist', pharmacistToken()],
      ['staff', cashierToken()],
    ] as [UserRole, string][]) {
      const response = await call('get', token);
      expect({ role, status: response.status }).toEqual({ role, status: 200 });
    }
  });

  it('returns the one envelope, with both spellings of every rate', async () => {
    const response = await call('get', ownerToken());
    expect(response.body.success).toBe(true);
    expect(response.body.data.taxSettings).toEqual({
      taxInclusivePricing: true,
      vat: { rate: 1_500, label: '15%', decimal: '0.1500' },
      nhil: { rate: 250, label: '2.5%', decimal: '0.0250' },
      getfund: { rate: 250, label: '2.5%', decimal: '0.0250' },
      combinedRate: 2_000,
      combinedLabel: '20%',
      matchesAct1151: true,
      act1151: {
        instrument: 'Value Added Tax Act, 2025 (Act 1151)',
        inForceFrom: '2026-01-01',
        source: 'https://gra.gov.gh/domestic-tax/tax-types/vat/',
        retrieved: '2026-09',
        vatRate: 1_500,
        nhilRate: 250,
        getfundRate: 250,
      },
      updatedAt: UPDATED_AT,
    });
  });

  it('reads the caller\'s own pharmacy and no other', async () => {
    await call('get', pharmacistToken());
    // The token carries the pharmacy, so the id is never taken from the request.
    // A route that read it from a query parameter would let any authenticated
    // user ask about any pharmacy, and this build having one tenant is not a
    // reason to leave the door shaped that way.
    expect(readMock).toHaveBeenCalledWith(PHARMACY);
    expect(readMock).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /tax/settings', () => {
  it('is the owner\'s alone', async () => {
    const owner = await call('put', ownerToken(), VALID_BODY);
    expect(owner.status).toBe(200);

    // 403 and not 401: both are authenticated, and telling them otherwise would
    // send a pharmacist to sign in again rather than to ask the owner.
    for (const [role, token] of [
      ['pharmacist', pharmacistToken()],
      ['staff', cashierToken()],
    ] as [UserRole, string][]) {
      const response = await call('put', token, VALID_BODY);
      const body = errorOf(response.body);
      expect({ role, status: response.status, code: body.error.code }).toEqual({
        role,
        status: 403,
        code: 'forbidden',
      });
      expect(body.error.details).toEqual({ missing: ['tax:change'] });
    }
  });

  it('does no work at all for a role that may not do it', async () => {
    await call('put', cashierToken(), VALID_BODY);
    // Authorisation runs before the handler, so a refused cashier leaves no
    // trace in the settings. The opposite ordering would be a route that reads
    // and validates on everybody's behalf and then decides whether to answer.
    expect(writeMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
  });

  it('saves what the owner sent, canonicalised, and answers with what is stored', async () => {
    const response = await call('put', ownerToken(), {
      ...VALID_BODY,
      vatRate: '0.15',
      taxInclusivePricing: false,
    });

    expect(response.status).toBe(200);
    expect(writeMock).toHaveBeenCalledWith(PHARMACY, {
      taxInclusivePricing: false,
      // `'0.15'` in, `'0.1500'` stored: one spelling in the column, so a
      // comparison against GRA is about integers rather than about text.
      vatRate: '0.1500',
      nhilRate: '0.0250',
      getfundRate: '0.0250',
    });
    expect(response.body.data.taxSettings.vat).toEqual({
      rate: 1_500,
      label: '15%',
      decimal: '0.1500',
    });
    expect(response.body.data.taxSettings.taxInclusivePricing).toBe(false);
  });

  it('refuses a body with no pricing mode, naming the field', async () => {
    const { taxInclusivePricing: _omitted, ...rest } = VALID_BODY;
    const response = await call('put', ownerToken(), rest);
    const body = errorOf(response.body);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual([
      {
        field: 'taxInclusivePricing',
        message: 'Say whether shelf prices already include the tax',
      },
    ]);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('refuses a missing rate in the engine\'s own words for it', async () => {
    const response = await call('put', ownerToken(), {
      taxInclusivePricing: true,
      nhilRate: '0.0250',
      getfundRate: '0.0250',
    });
    const body = errorOf(response.body);
    expect(response.status).toBe(400);
    // Presence is the route's job; the range past it is the engine's. The two
    // layers word the same field the same way, so the owner cannot tell which
    // refused and does not need to.
    expect(body.error.details).toEqual([{ field: 'vatRate', message: 'Enter the VAT rate' }]);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('carries the engine\'s refusal through to the browser as a field error', async () => {
    // The assertion this suite exists for. There is no regex for a rate on the
    // route, so the refusal comes from `parseRate` in the shared package — and
    // it still has to arrive as a 400 with a field path, not as a 500 with a
    // withheld message. A `TaxError` that escaped to the error middleware would
    // look exactly like that.
    const response = await call('put', ownerToken(), {
      ...VALID_BODY,
      vatRate: '15%',
      getfundRate: '2.5',
    });
    const body = errorOf(response.body);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual([
      {
        field: 'vatRate',
        message: 'Enter the VAT rate as a decimal with at most four places, between 0 and 1',
        code: 'rate_out_of_range',
      },
      {
        field: 'getfundRate',
        message: 'Enter the GETFund levy rate as a decimal with at most four places, between 0 and 1',
        code: 'rate_out_of_range',
      },
    ]);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('answers 401 with no token, and never reaches the settings', async () => {
    const response = await call('put', undefined, VALID_BODY);
    expect(response.status).toBe(401);
    expect(errorOf(response.body).error.code).toBe('not_authenticated');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('reports a pharmacy that is not there rather than saving to nothing', async () => {
    writeMock.mockRejectedValue(new HttpError(404, 'No pharmacy matches that id', {
      code: 'not_found',
    }));
    const response = await call('put', ownerToken(), VALID_BODY);
    expect(response.status).toBe(404);
    expect(errorOf(response.body).error.code).toBe('not_found');
  });
});
