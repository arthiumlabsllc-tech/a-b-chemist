jest.mock('../repositories/users.repository', () => ({
  // The repository is mocked here and the pool is mocked nowhere: this suite is
  // about the route — its validation, its authorisation, the last-owner guard
  // and what it refuses to let you do. The SQL behind those calls is proven
  // against real Postgres by the harness in database/tests.
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

import request from 'supertest';
import { createApp } from '../app';
import {
  countActiveOwners,
  createStaff,
  findUserById,
  listStaff,
  setPassword,
  updateStaff,
  type NewStaff,
  type StaffPatch,
  type UserRow,
} from '../repositories/users.repository';
import { signAccessToken } from '../utils/jwt';
import { HttpError } from '../utils/http';
import { isBcryptHash, verifyPassword } from '../utils/password';
import type { UserRole } from '../utils/permissions';

/**
 * Staff management, over HTTP.
 */

const app = createApp();

const findUserByIdMock = findUserById as jest.Mock;
const listStaffMock = listStaff as jest.Mock;
const createStaffMock = createStaff as jest.Mock;
const countActiveOwnersMock = countActiveOwners as jest.Mock;
const updateStaffMock = updateStaff as jest.Mock;
const setPasswordMock = setPassword as jest.Mock;

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PHARMACY = 'b0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const PHARMACIST_ID = 'a0000000-0000-4000-8000-000000000003';
const CASHIER_ID = 'a0000000-0000-4000-8000-000000000004';
const TARGET_ID = 'a0000000-0000-4000-8000-000000000005';
const STORED_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS';

let users: Record<string, UserRow>;

function row(id: string, overrides: Partial<UserRow> = {}): UserRow {
  return {
    id,
    pharmacyId: PHARMACY,
    fullName: 'Unnamed',
    email: `${id}@aandb.example`,
    phone: null,
    role: 'staff',
    passwordHash: STORED_HASH,
    isActive: true,
    sessionVersion: 2,
    lastLoginAt: null,
    ...overrides,
  };
}

function tokenFor(id: string, role: UserRole): string {
  return signAccessToken({ userId: id, pharmacyId: PHARMACY, role, sessionVersion: 2 });
}

const ownerToken = (): string => tokenFor(OWNER_ID, 'pharmacy_owner');
const pharmacistToken = (): string => tokenFor(PHARMACIST_ID, 'pharmacist');
const cashierToken = (): string => tokenFor(CASHIER_ID, 'staff');

/** Moves a known-present row to another pharmacy, for the scope tests. */
function moveToAnotherPharmacy(id: string): void {
  const existing = users[id];
  if (existing === undefined) throw new Error(`test fixture has no user ${id}`);
  users[id] = { ...existing, pharmacyId: OTHER_PHARMACY };
}

function call(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  token: string | undefined,
  body?: object
): request.Test {
  const agent = request(app);
  const test =
    method === 'get'
      ? agent.get(path)
      : method === 'post'
        ? agent.post(path)
        : method === 'patch'
          ? agent.patch(path)
          : agent.delete(path);
  if (token !== undefined) test.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) test.send(body);
  return test;
}

beforeEach(() => {
  users = {
    [OWNER_ID]: row(OWNER_ID, {
      fullName: 'Beatrice Owusu',
      email: 'owner@aandb.example',
      role: 'pharmacy_owner',
    }),
    [PHARMACIST_ID]: row(PHARMACIST_ID, { fullName: 'Ama Mensah', role: 'pharmacist' }),
    [CASHIER_ID]: row(CASHIER_ID, { fullName: 'Kojo Antwi', role: 'staff' }),
    [TARGET_ID]: row(TARGET_ID, { fullName: 'Efua Boakye', role: 'staff' }),
  };

  findUserByIdMock.mockImplementation(async (id: string) => users[id] ?? null);
  listStaffMock.mockImplementation(async (pharmacyId: string) =>
    Object.values(users).filter((user) => user.pharmacyId === pharmacyId)
  );
  createStaffMock.mockImplementation(async (input: NewStaff) =>
    row('a0000000-0000-4000-8000-0000000000ff', {
      pharmacyId: input.pharmacyId,
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      role: input.role,
      passwordHash: input.passwordHash,
      sessionVersion: 0,
    })
  );
  // One active owner by default: the pharmacy has Beatrice and nobody else.
  countActiveOwnersMock.mockResolvedValue(1);
  updateStaffMock.mockImplementation(
    async (id: string, patch: StaffPatch, _options: { invalidateSessions: boolean }) => {
      const existing = users[id];
      if (existing === undefined) return null;
      const updated: UserRow = { ...existing, ...patch };
      users[id] = updated;
      return updated;
    }
  );
  setPasswordMock.mockResolvedValue(undefined);
});

describe('who may manage staff', () => {
  it('refuses an anonymous caller', async () => {
    const response = await call('get', '/staff', undefined);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('not_authenticated');
  });

  it('refuses a pharmacist, who can run the dispensary but not hand out accounts', async () => {
    const response = await call('get', '/staff', pharmacistToken());

    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({
      message: expect.any(String),
      code: 'forbidden',
      details: { missing: ['staff:manage'] },
    });
  });

  it('refuses counter staff', async () => {
    const response = await call('get', '/staff', cashierToken());

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('refuses every write verb to a pharmacist, not just the list', async () => {
    // Authorisation is on the mount, so it is worth proving that it covers the
    // whole router rather than only the first route in it.
    for (const attempt of [
      call('post', '/staff', pharmacistToken(), {
        fullName: 'New Person',
        email: 'new@aandb.example',
        role: 'staff',
        initialPassword: 'welcome-2026',
      }),
      call('patch', `/staff/${TARGET_ID}`, pharmacistToken(), { isActive: false }),
      call('post', `/staff/${TARGET_ID}/reset-password`, pharmacistToken(), {
        newPassword: 'welcome-2026',
      }),
      call('delete', `/staff/${TARGET_ID}`, pharmacistToken()),
    ]) {
      expect((await attempt).status).toBe(403);
    }
  });

  it('admits the owner', async () => {
    const response = await call('get', '/staff', ownerToken());

    expect(response.status).toBe(200);
  });
});

describe('GET /staff', () => {
  it('lists the pharmacy staff and publishes no password material', async () => {
    const response = await call('get', '/staff', ownerToken());

    expect(response.status).toBe(200);
    expect(response.body.data.staff).toHaveLength(4);
    expect(response.body.data.staff[0]).toEqual({
      id: expect.any(String),
      fullName: expect.any(String),
      email: expect.any(String),
      phone: null,
      role: expect.any(String),
      isActive: true,
      lastLoginAt: null,
    });

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(STORED_HASH);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('sessionVersion');
  });

  it('lists only the caller\u2019s own pharmacy', async () => {
    users['a0000000-0000-4000-8000-0000000000aa'] = row(
      'a0000000-0000-4000-8000-0000000000aa',
      { pharmacyId: OTHER_PHARMACY, fullName: 'Somewhere Else' }
    );

    const response = await call('get', '/staff', ownerToken());

    // The scope comes from the token, not from a query parameter. There is no
    // `?pharmacyId=` to tamper with, which is the point.
    expect(listStaffMock).toHaveBeenCalledWith(PHARMACY);
    expect(JSON.stringify(response.body)).not.toContain('Somewhere Else');
  });
});

describe('POST /staff', () => {
  const valid = {
    fullName: 'Yaw Darko',
    email: 'yaw@aandb.example',
    phone: '0244000000',
    role: 'staff',
    initialPassword: 'welcome-2026',
  };

  it('creates the account and answers 201', async () => {
    const response = await call('post', '/staff', ownerToken(), valid);

    expect(response.status).toBe(201);
    expect(response.body.data.staff).toEqual(
      expect.objectContaining({ fullName: 'Yaw Darko', email: 'yaw@aandb.example', role: 'staff' })
    );
  });

  it('stores a bcrypt hash, never the password', async () => {
    await call('post', '/staff', ownerToken(), valid);

    const input = createStaffMock.mock.calls[0]?.[0] as NewStaff;
    expect(isBcryptHash(input.passwordHash)).toBe(true);
    expect(input.passwordHash).not.toBe('welcome-2026');
    await expect(verifyPassword('welcome-2026', input.passwordHash)).resolves.toBe(true);
  });

  it('does not echo the initial password back', async () => {
    const response = await call('post', '/staff', ownerToken(), valid);

    // The owner typed it, so they already have it. A password in a response body
    // ends up in proxy logs, in browser devtools history and in any error report
    // that captures responses, for no benefit at all.
    expect(JSON.stringify(response.body)).not.toContain('welcome-2026');
  });

  it('takes the pharmacy from the token and ignores one posted in the body', async () => {
    await call('post', '/staff', ownerToken(), { ...valid, pharmacyId: OTHER_PHARMACY });

    const input = createStaffMock.mock.calls[0]?.[0] as NewStaff;
    expect(input.pharmacyId).toBe(PHARMACY);
  });

  it('reports a duplicate email as 409', async () => {
    // The real repository translates the unique violation on lower(email) into
    // exactly this error, so the route is tested against what it will receive.
    createStaffMock.mockRejectedValueOnce(
      new HttpError(409, 'A staff member with that email already exists', {
        code: 'email_taken',
      })
    );

    const response = await call('post', '/staff', ownerToken(), valid);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('email_taken');
  });

  it.each([
    ['a password shorter than eight', { ...valid, initialPassword: 'short' }],
    ['a password of 200 characters', { ...valid, initialPassword: 'x'.repeat(200) }],
    ['no password at all', { fullName: valid.fullName, email: valid.email, role: valid.role }],
    ['a role that does not exist', { ...valid, role: 'super_admin' }],
    ['an email that is not an email', { ...valid, email: 'not-an-email' }],
    ['a name of one character', { ...valid, fullName: 'Y' }],
  ])('refuses %s', async (_reason, body) => {
    const response = await call('post', '/staff', ownerToken(), body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
    expect(createStaffMock).not.toHaveBeenCalled();
  });

  it('accepts a pharmacist and an owner, and stores no phone when none is given', async () => {
    for (const role of ['pharmacist', 'pharmacy_owner'] as UserRole[]) {
      const response = await call('post', '/staff', ownerToken(), {
        ...valid,
        role,
        email: `${role}@aandb.example`,
        phone: null,
      });

      expect(response.status).toBe(201);
      expect((createStaffMock.mock.calls.at(-1)?.[0] as NewStaff).phone).toBeNull();
    }
  });
});

describe('PATCH /staff/:id', () => {
  it('renames someone without ending their session', async () => {
    const response = await call('patch', `/staff/${TARGET_ID}`, ownerToken(), {
      fullName: 'Efua Boakye-Yirenkyi',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.sessionsEnded).toBe(false);
    expect(updateStaffMock).toHaveBeenCalledWith(
      TARGET_ID,
      { fullName: 'Efua Boakye-Yirenkyi' },
      { invalidateSessions: false }
    );
  });

  it('ends the session when the role changes', async () => {
    const response = await call('patch', `/staff/${TARGET_ID}`, ownerToken(), {
      role: 'pharmacist',
    });

    // A token asserts the role it was signed with. Without this bump a cashier
    // promoted mid-shift would keep a token saying `staff` and a cashier demoted
    // mid-shift would keep one saying `pharmacist` — the second of which is a
    // person approving prescriptions for up to an hour after losing the right.
    expect(response.body.data.sessionsEnded).toBe(true);
    expect(updateStaffMock).toHaveBeenCalledWith(
      TARGET_ID,
      { role: 'pharmacist' },
      { invalidateSessions: true }
    );
  });

  it.each([
    ['deactivating', { isActive: false }],
    ['reactivating', { isActive: true }],
  ])('ends the session when %s an account', async (_verb, patch) => {
    const response = await call('patch', `/staff/${TARGET_ID}`, ownerToken(), patch);

    // Reactivating bumps too: an old refresh token that was refused only
    // because the account was inactive would otherwise come back to life, and
    // it may have been copied while it was still valid.
    expect(response.body.data.sessionsEnded).toBe(true);
  });

  it('refuses to deactivate the last active owner', async () => {
    countActiveOwnersMock.mockResolvedValue(0);

    const response = await call('patch', `/staff/${OWNER_ID}`, ownerToken(), {
      isActive: false,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('last_owner');
    expect(updateStaffMock).not.toHaveBeenCalled();
  });

  it('refuses to demote the last active owner', async () => {
    countActiveOwnersMock.mockResolvedValue(0);

    const response = await call('patch', `/staff/${OWNER_ID}`, ownerToken(), {
      role: 'pharmacist',
    });

    // Demotion is the same lockout as deactivation: afterwards nobody can add
    // staff, change tax settings or void a sale, and no route can put it right.
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('last_owner');
  });

  it('allows deactivating an owner once another active owner exists', async () => {
    countActiveOwnersMock.mockResolvedValue(1);

    const response = await call('patch', `/staff/${OWNER_ID}`, ownerToken(), {
      isActive: false,
    });

    expect(response.status).toBe(200);
    expect(countActiveOwnersMock).toHaveBeenCalledWith(PHARMACY, OWNER_ID);
  });

  it('does not consult the owner count for an edit that cannot cause a lockout', async () => {
    await call('patch', `/staff/${TARGET_ID}`, ownerToken(), { fullName: 'Efua B.' });

    // TARGET_ID is a cashier, so no counting is needed. Asserted because a
    // needless query on every rename is a small cost that becomes a habit.
    expect(countActiveOwnersMock).not.toHaveBeenCalled();
  });

  it('refuses an edit that sends nothing', async () => {
    const response = await call('patch', `/staff/${TARGET_ID}`, ownerToken(), {});

    // Reported rather than answered with an unchanged row: a silent no-op is a
    // frontend that believes it saved something it never sent.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('nothing_to_update');
    expect(updateStaffMock).not.toHaveBeenCalled();
  });

  it('will not change an email address', async () => {
    const response = await call('patch', `/staff/${TARGET_ID}`, ownerToken(), {
      email: 'someone.else@aandb.example',
    });

    // The email is the login identity. Handing it to a different person would
    // transfer that person's history with it, so it is not an editable field.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('nothing_to_update');
  });

  it('answers 404 for an id that does not exist', async () => {
    const response = await call(
      'patch',
      '/staff/a0000000-0000-4000-8000-0000000000ee',
      ownerToken(),
      { fullName: 'Nobody' }
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('answers 404, not 403, for a staff member in another pharmacy', async () => {
    moveToAnotherPharmacy(TARGET_ID);

    const response = await call('patch', `/staff/${TARGET_ID}`, ownerToken(), {
      isActive: false,
    });

    // 403 would confirm the id exists and belongs to someone else. This build
    // has one tenant, but the scope check is written as though it does not.
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('refuses a malformed id before looking anything up', async () => {
    const response = await call('patch', '/staff/not-a-uuid', ownerToken(), { isActive: false });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
    // `authenticate` has already looked the owner up, so this asserts the
    // target was never queried: validation runs before the route touches data.
    expect(findUserByIdMock).not.toHaveBeenCalledWith('not-a-uuid');
  });
});

describe('POST /staff/:id/reset-password', () => {
  it('stores a new hash and ends every session that account held', async () => {
    const response = await call('post', `/staff/${TARGET_ID}/reset-password`, ownerToken(), {
      newPassword: 'a-fresh-start-2026',
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      staffId: TARGET_ID,
      passwordReset: true,
      sessionsEnded: true,
    });

    const [id, storedHash] = setPasswordMock.mock.calls[0] as [string, string];
    expect(id).toBe(TARGET_ID);
    expect(isBcryptHash(storedHash)).toBe(true);
    await expect(verifyPassword('a-fresh-start-2026', storedHash)).resolves.toBe(true);
  });

  it('refuses a password that is too short', async () => {
    const response = await call('post', `/staff/${TARGET_ID}/reset-password`, ownerToken(), {
      newPassword: 'abc',
    });

    expect(response.status).toBe(400);
    expect(setPasswordMock).not.toHaveBeenCalled();
  });

  it('refuses to reset the password of someone in another pharmacy', async () => {
    moveToAnotherPharmacy(TARGET_ID);

    const response = await call('post', `/staff/${TARGET_ID}/reset-password`, ownerToken(), {
      newPassword: 'a-fresh-start-2026',
    });

    expect(response.status).toBe(404);
    expect(setPasswordMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /staff/:id', () => {
  it('is not a route, for anyone', async () => {
    const response = await call('delete', `/staff/${TARGET_ID}`, ownerToken());

    // Deactivation, not deletion: `sales.served_by` names the person who served
    // each sale. Deleting them would orphan the receipt or cascade away the
    // record of who dispensed what to whom, and a pharmacy that cannot say who
    // sold a medicine cannot answer a recall.
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});
