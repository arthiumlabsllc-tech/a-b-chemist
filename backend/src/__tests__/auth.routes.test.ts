jest.mock('../database/pool', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  probeDatabase: jest.fn().mockResolvedValue({ ok: false, error: 'unused in this suite' }),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

import request from 'supertest';
import { createApp } from '../app';
import { config } from '../config';
import { query } from '../database/pool';
import { verifyAccessToken } from '../utils/jwt';
import { hashPassword } from '../utils/password';

/**
 * The sign-in surface, over HTTP.
 *
 * The database is an in-memory stand-in driven through the same `query` the
 * repositories call, so the real repository SQL shapes, the real service
 * decisions and the real middleware all run. What is faked is Postgres, not the
 * code under test.
 *
 * Two things only a suite at this level can prove: that the response envelope
 * carries no password material, and that the auth rate limiter is keyed per
 * client rather than per pharmacy.
 */

const queryMock = query as jest.Mock;

const app = createApp();

const PASSWORD = 'counter-shift-2026';
let passwordHash = '';

const PHARMACY_ID = 'a0000000-0000-4000-8000-000000000001';
const AMA = 'a0000000-0000-4000-8000-000000000002';
const KOJO = 'a0000000-0000-4000-8000-000000000003';
const OWNER = 'a0000000-0000-4000-8000-000000000004';

interface DbUser {
  id: string;
  pharmacy_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: string;
  password_hash: string;
  is_active: boolean;
  session_version: number;
  last_login_at: string | null;
}

let users: DbUser[] = [];

/**
 * A fresh client per test.
 *
 * 203.0.113.0/24 is RFC 5737 documentation space, so nothing here can reach a
 * real host. The counter is never reset: the limiter's store lives as long as
 * the module, and two tests sharing an address would inherit each other's
 * attempt count and the eleventh request would be refused for no reason the
 * failing test could see.
 */
let clientCounter = 0;
function nextClient(): string {
  clientCounter += 1;
  return `203.0.113.${clientCounter}`;
}

function call(
  method: 'get' | 'post',
  path: string,
  options: { token?: string; body?: object; ip?: string } = {}
): request.Test {
  const agent = request(app);
  const test: request.Test = method === 'get' ? agent.get(path) : agent.post(path);
  // Every request names a client. With `trust proxy` on, this is what `req.ip`
  // becomes, and therefore what both rate limiters bucket on.
  test.set('X-Forwarded-For', options.ip ?? nextClient());
  if (options.token !== undefined) test.set('Authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) test.send(options.body);
  return test;
}

function post(path: string, body: object, ip?: string): request.Test {
  return call('post', path, { body, ip });
}

function get(path: string, token?: string): request.Test {
  return call('get', path, { token });
}

/** Signs out with `token`, the way the till does. */
function logout(token: string): request.Test {
  return call('post', '/auth/logout', { token, body: {} });
}

/** Signs in and returns the tokens, failing the test if that did not work. */
async function signIn(
  email = 'ama@aandb.example',
  password = PASSWORD
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await post('/auth/login', { email, password });
  expect(response.status).toBe(200);
  return {
    accessToken: response.body.data.accessToken as string,
    refreshToken: response.body.data.refreshToken as string,
  };
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});

beforeEach(() => {
  users = [
    {
      id: AMA,
      pharmacy_id: PHARMACY_ID,
      full_name: 'Ama Mensah',
      email: 'ama@aandb.example',
      phone: null,
      role: 'pharmacist',
      password_hash: passwordHash,
      is_active: true,
      session_version: 3,
      last_login_at: null,
    },
    {
      id: KOJO,
      pharmacy_id: PHARMACY_ID,
      full_name: 'Kojo Antwi',
      email: 'kojo@aandb.example',
      phone: null,
      role: 'staff',
      password_hash: passwordHash,
      is_active: false,
      session_version: 1,
      last_login_at: null,
    },
    {
      id: OWNER,
      pharmacy_id: PHARMACY_ID,
      full_name: 'Owner',
      email: 'owner@localhost',
      phone: null,
      role: 'pharmacy_owner',
      // What init.sql seeds. Not a hash, and it must never verify.
      password_hash: 'UNSET',
      is_active: true,
      session_version: 0,
      last_login_at: null,
    },
  ];

  queryMock.mockReset();
  queryMock.mockImplementation(async (text: string, params: unknown[] = []) => {
    const none = { rows: [], rowCount: 0 };

    if (text.includes('session_version = session_version + 1')) {
      const target = users.find((user) => user.id === params[0]);
      if (target !== undefined) target.session_version += 1;
      return none;
    }
    if (text.includes('last_login_at = now()')) {
      const target = users.find((user) => user.id === params[0]);
      if (target !== undefined) target.last_login_at = new Date().toISOString();
      return none;
    }
    if (text.includes('from users where lower(email)')) {
      const email = String(params[0]).toLowerCase();
      const found = users.filter((user) => user.email.toLowerCase() === email);
      return { rows: found, rowCount: found.length };
    }
    if (text.includes('from users where id = $1')) {
      const found = users.filter((user) => user.id === params[0]);
      return { rows: found, rowCount: found.length };
    }
    return none;
  });
});

describe('POST /auth/login', () => {
  it('returns tokens, the safe user and the permissions on success', async () => {
    const response = await post('/auth/login', {
      email: 'ama@aandb.example',
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.user).toEqual({
      id: AMA,
      fullName: 'Ama Mensah',
      email: 'ama@aandb.example',
      role: 'pharmacist',
      isActive: true,
    });
    expect(response.body.data.accessExpiresInSeconds).toBe(config.jwt.accessTtlSeconds);
    expect(response.body.data.permissions).toContain('prescriptions:approve');
    expect(response.body.data.permissions).not.toContain('staff:manage');

    // The token that came back is the one the middleware will accept, and it
    // carries the pharmacy scope the server will read rather than the client.
    expect(verifyAccessToken(response.body.data.accessToken as string)).toEqual({
      userId: AMA,
      pharmacyId: PHARMACY_ID,
      role: 'pharmacist',
      sessionVersion: 3,
    });
  });

  it('publishes no password material anywhere in the response', async () => {
    const response = await post('/auth/login', {
      email: 'ama@aandb.example',
      password: PASSWORD,
    });

    const serialised = JSON.stringify(response.body) + JSON.stringify(response.headers);
    expect(serialised).not.toContain(passwordHash);
    expect(serialised).not.toContain('password_hash');
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('sessionVersion');
    expect(serialised).not.toContain('session_version');
    expect(serialised).not.toContain(PASSWORD);
  });

  it('answers 401 for a wrong password', async () => {
    const response = await post('/auth/login', {
      email: 'ama@aandb.example',
      password: 'not-the-password',
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'invalid_credentials' }),
    });
  });

  it('answers an unknown email exactly as it answers a wrong password', async () => {
    const wrongPassword = await post('/auth/login', {
      email: 'ama@aandb.example',
      password: 'not-the-password',
    });
    const unknownEmail = await post('/auth/login', {
      email: 'nobody@aandb.example',
      password: 'not-the-password',
    });

    // Byte-identical, not merely the same status. Any difference — a different
    // message, an extra field — turns sign-in into a staff directory.
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it('matches the email regardless of case and surrounding space', async () => {
    const response = await post('/auth/login', {
      email: '  AMA@AANDB.EXAMPLE ',
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
  });

  it('answers 403 for a deactivated account holding the correct password', async () => {
    const response = await post('/auth/login', {
      email: 'kojo@aandb.example',
      password: PASSWORD,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('account_disabled');
    // Told apart from a wrong password because the remedy is different: this
    // person needs the owner, not another attempt.
    expect(response.body.error.code).not.toBe('invalid_credentials');
  });

  it('answers 403 password_not_set for the seeded owner', async () => {
    const response = await post('/auth/login', {
      email: 'owner@localhost',
      // The seed ships 'UNSET' as the hash. If that value were ever compared
      // as a password, this attempt would succeed.
      password: 'UNSET',
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('password_not_set');
  });

  it('answers 400 with the field name when the email is missing', async () => {
    const response = await post('/auth/login', { password: PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'email' })])
    );
  });

  it('answers 400 when the password is empty', async () => {
    const response = await post('/auth/login', { email: 'ama@aandb.example', password: '' });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'password' })])
    );
  });

  it('stamps last_login_at on success and not on failure', async () => {
    await post('/auth/login', { email: 'ama@aandb.example', password: 'wrong' });
    expect(users.find((user) => user.id === AMA)?.last_login_at).toBeNull();

    await post('/auth/login', { email: 'ama@aandb.example', password: PASSWORD });
    expect(users.find((user) => user.id === AMA)?.last_login_at).toEqual(expect.any(String));
  });
});

describe('POST /auth/refresh', () => {
  it('issues a fresh pair for a live refresh token', async () => {
    const { refreshToken } = await signIn();

    const response = await post('/auth/refresh', { refreshToken });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.refreshToken).toEqual(expect.any(String));
    expect(verifyAccessToken(response.body.data.accessToken as string).userId).toBe(AMA);
  });

  it('refuses an access token offered as a refresh token', async () => {
    const { accessToken } = await signIn();

    const response = await post('/auth/refresh', { refreshToken: accessToken });

    // The cross-use case that two secrets and a `typ` claim exist to stop.
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_token');
  });

  it('refuses garbage and an absent token with 401 and 400 respectively', async () => {
    const garbage = await post('/auth/refresh', { refreshToken: 'abc.def.ghi' });
    expect(garbage.status).toBe(401);
    expect(garbage.body.error.code).toBe('invalid_token');

    const absent = await post('/auth/refresh', {});
    expect(absent.status).toBe(400);
    expect(absent.body.error.code).toBe('validation_failed');
  });

  it('refuses a refresh token from a session that has been signed out', async () => {
    const { accessToken, refreshToken } = await signIn();
    await logout(accessToken);

    const response = await post('/auth/refresh', { refreshToken });

    // Revocation reaches the refresh token too. Without it, signing out would
    // only end the hour-long credential and leave the seven-day one alive.
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('session_revoked');
  });
});

describe('GET /auth/me', () => {
  it('answers 401 with no token', async () => {
    const response = await get('/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('not_authenticated');
  });

  it('returns the signed-in user and their permissions', async () => {
    const { accessToken } = await signIn();

    const response = await get('/auth/me', accessToken);

    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe('ama@aandb.example');
    expect(response.body.data.permissions).toEqual(expect.arrayContaining(['sales:create']));
    expect(JSON.stringify(response.body)).not.toContain(passwordHash);
  });

  it('answers 401 session_revoked for a token from a signed-out session', async () => {
    const { accessToken } = await signIn();
    expect((await get('/auth/me', accessToken)).status).toBe(200);

    await logout(accessToken);

    const after = await get('/auth/me', accessToken);

    // The same token, the same signature, still within its hour. It is refused
    // because the server moved the version number — which is the difference
    // between a stateless token and a revocable session.
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('session_revoked');
  });
});

describe('POST /auth/logout', () => {
  it('answers 401 with no token', async () => {
    const response = await post('/auth/logout', {});

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('not_authenticated');
  });

  it('signs out and bumps the stored session version', async () => {
    const { accessToken } = await signIn();
    const before = users.find((user) => user.id === AMA)?.session_version;

    const response = await logout(accessToken);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { signedOut: true } });
    expect(users.find((user) => user.id === AMA)?.session_version).toBe((before ?? 0) + 1);
  });
});

describe('endpoints that must not exist', () => {
  const body = { email: 'whoever@example.com', password: PASSWORD };

  it.each(['/auth/register', '/auth/signup', '/auth/forgot-password'])(
    '%s is refused before it is even routed',
    async (path) => {
      const response = await post(path, body);

      // 401, not 404. The authenticated `/auth` mount matches on the prefix, so
      // `authenticate` runs before the router has a chance to say "no such
      // route". That is stronger than a 404: a caller with no token cannot even
      // learn which paths under /auth exist.
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('not_authenticated');
    }
  );

  it.each(['/auth/register', '/auth/signup', '/auth/forgot-password', '/register'])(
    '%s is not a route, for a signed-in owner either',
    async (path) => {
      const { accessToken } = await signIn();

      const response = await call('post', path, { token: accessToken, body });

      // One pharmacy, no self-service sign-up and no unverified password reset.
      // A registration route would be the shortest path from the internet to a
      // staff token, and a reset route without an email provider would be a way
      // to lock someone out of their own account.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    }
  );
});

describe('auth rate limiting', () => {
  it('refuses the attempt after the configured maximum, from the same client', async () => {
    const ip = nextClient();
    const attempt = (): request.Test =>
      post('/auth/login', { email: 'ama@aandb.example', password: 'wrong' }, ip);

    for (let index = 0; index < config.rateLimit.authMax; index += 1) {
      const response = await attempt();
      expect(response.status).toBe(401);
    }

    const refused = await attempt();

    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'rate_limited' }),
    });
  });

  it('leaves a different client untouched, which is the whole point of trust proxy', async () => {
    const exhausted = nextClient();
    for (let index = 0; index <= config.rateLimit.authMax; index += 1) {
      await post('/auth/login', { email: 'ama@aandb.example', password: 'wrong' }, exhausted);
    }
    expect(
      (await post('/auth/login', { email: 'ama@aandb.example', password: 'wrong' }, exhausted))
        .status
    ).toBe(429);

    // Another device in the same pharmacy. If `trust proxy` were unset, every
    // request would arrive from Render's forwarder, share one bucket, and this
    // would be a 429 — one cashier guessing a password would lock the till.
    const other = await post(
      '/auth/login',
      { email: 'ama@aandb.example', password: PASSWORD },
      nextClient()
    );

    expect(other.status).toBe(200);
  });

  it('reports the budget in response headers', async () => {
    const response = await post('/auth/login', {
      email: 'ama@aandb.example',
      password: PASSWORD,
    });

    const rateLimitHeaders = Object.keys(response.headers).filter((name) =>
      name.toLowerCase().startsWith('ratelimit')
    );

    // draft-7 headers, so a client can back off before it is refused rather
    // than discovering the limit by hitting it.
    expect(rateLimitHeaders.length).toBeGreaterThan(0);
  });
});
