jest.mock('../database/pool', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  probeDatabase: jest.fn().mockResolvedValue({ ok: false, error: 'unused in this suite' }),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

import { query } from '../database/pool';
import fs from 'fs';
import path from 'path';
import {
  bumpSessionVersion,
  countActiveOwners,
  createStaff,
  findUserByEmail,
  findUserById,
  listStaff,
  markLogin,
  setPassword,
  updateStaff,
  type NewStaff,
  type StaffPatch,
} from '../repositories/users.repository';
import { HttpError } from '../utils/http';

/**
 * The SQL the users repository emits.
 *
 * Every other suite that touches staff management mocks this module, so this is
 * the only place the statements themselves are pinned. That matters because the
 * interesting failures here are not logic errors a reader would spot — they are
 * a placeholder numbered one out, a bump left out of a SET clause, or a value
 * interpolated into the statement instead of passed as a parameter. All three
 * compile, all three pass a route test that mocks the repository, and the first
 * two only appear when a real pharmacist is edited.
 *
 * This proves construction, not execution: that the statement says what it
 * should and that nothing user-supplied is inside it. That the statement is also
 * valid against the real schema is the harness's job — `database/tests`
 * runs these same shapes in Postgres 16.
 */

const queryMock = query as jest.Mock;

interface Call {
  text: string;
  params: unknown[];
}

let calls: Call[] = [];

/** Collapses whitespace so a reformat is not a failure but a rewrite is. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const COLUMNS = normalise(`
  id, pharmacy_id, full_name, email, phone, role, password_hash,
  is_active, session_version, last_login_at
`);

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a0000000-0000-4000-8000-000000000002';

/** A row as Postgres returns it: snake_case, since `mapRow` does the renaming. */
function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER,
    pharmacy_id: PHARMACY,
    full_name: 'Ama Mensah',
    email: 'ama@aandb.example',
    phone: null,
    role: 'pharmacist',
    password_hash: '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpMbS0nVBM7iFtXJGvYxQmC5nqJZS',
    is_active: true,
    session_version: 3,
    last_login_at: null,
    ...overrides,
  };
}

/** The single statement a call is expected to have produced. */
function onlyCall(): Call {
  if (calls.length !== 1) {
    throw new Error(`expected exactly one query, saw ${calls.length}: ${JSON.stringify(calls)}`);
  }
  const first = calls[0];
  if (first === undefined) throw new Error('unreachable: length was checked above');
  return first;
}

/**
 * Scripted outcomes, consumed in order.
 *
 * Not `queryMock.mockResolvedValueOnce`: that replaces the implementation for
 * the call, so the recording wrapper never runs and `calls` is empty by the time
 * the assertion looks at it. Everything goes through one implementation, which
 * records first and then decides what to answer.
 */
type Outcome = { rows: Record<string, unknown>[] } | { error: unknown };

let scripted: Outcome[] = [];
let fallback: { rows: Record<string, unknown>[] } = { rows: [dbRow()] };

function queueRows(rows: Record<string, unknown>[]): void {
  scripted.push({ rows });
}

function queueError(error: unknown): void {
  scripted.push({ error });
}

/** Makes every subsequent call in this test find nothing. */
function alwaysEmpty(): void {
  fallback = { rows: [] };
}

beforeEach(() => {
  calls = [];
  scripted = [];
  fallback = { rows: [dbRow()] };
  queryMock.mockReset();
  queryMock.mockImplementation(async (text: string, params: readonly unknown[] = []) => {
    calls.push({ text: normalise(text), params: [...params] });

    const outcome = scripted.shift();
    if (outcome !== undefined && 'error' in outcome) throw outcome.error;

    const rows = outcome !== undefined ? outcome.rows : fallback.rows;
    return { rows, rowCount: rows.length };
  });
});

describe('reads', () => {
  it('matches the email case-insensitively on both sides of the comparison', async () => {
    await findUserByEmail('AMA@AANDB.EXAMPLE');

    expect(onlyCall().text).toBe(
      `select ${COLUMNS} from users where lower(email) = lower($1) limit 1`
    );
    // The value is passed as typed, not pre-lowered in JavaScript: lower() on
    // the column is what lets the unique index on lower(email) be used, and
    // doing the folding in the application would leave the index unused.
    expect(onlyCall().params).toEqual(['AMA@AANDB.EXAMPLE']);
  });

  it('reads a user by primary key', async () => {
    await findUserById(USER);

    expect(onlyCall().text).toBe(`select ${COLUMNS} from users where id = $1`);
    expect(onlyCall().params).toEqual([USER]);
  });

  it('returns null, not undefined, when a read finds nothing', async () => {
    alwaysEmpty();

    await expect(findUserById(USER)).resolves.toBeNull();
    await expect(findUserByEmail('nobody@aandb.example')).resolves.toBeNull();
  });

  it('renames every column, and leaves the hash out of nothing', async () => {
    const row = await findUserById(USER);

    // `passwordHash` is present by design — login needs it — and the discipline
    // that keeps it out of responses lives in `toSafeUser`, whose type omits it.
    expect(row).toEqual({
      id: USER,
      pharmacyId: PHARMACY,
      fullName: 'Ama Mensah',
      email: 'ama@aandb.example',
      phone: null,
      role: 'pharmacist',
      passwordHash: expect.any(String),
      isActive: true,
      sessionVersion: 3,
      lastLoginAt: null,
    });
  });

  it('scopes the staff list to one pharmacy and orders it stably', async () => {
    await listStaff(PHARMACY);

    expect(onlyCall().text).toBe(
      `select ${COLUMNS} from users where pharmacy_id = $1 order by full_name, email`
    );
    expect(onlyCall().params).toEqual([PHARMACY]);
  });
});

describe('countActiveOwners', () => {
  it('counts only owners who are still active', async () => {
    queueRows([{ n: 2 }]);

    await expect(countActiveOwners(PHARMACY)).resolves.toBe(2);

    expect(onlyCall().text).toBe(
      normalise(`
        select count(*)::int as n from users
         where pharmacy_id = $1
           and role = 'pharmacy_owner'
           and is_active = true
           and ($2::uuid is null or id <> $2::uuid)
      `)
    );
    // No excluded user means the guard must not exclude anybody, which is why
    // the parameter is null rather than omitted: `$2 is null` short-circuits the
    // whole clause and every active owner is counted.
    expect(onlyCall().params).toEqual([PHARMACY, null]);
  });

  it('excludes the user being edited, so an owner editing themselves is not counted', async () => {
    queueRows([{ n: 0 }]);

    await expect(countActiveOwners(PHARMACY, USER)).resolves.toBe(0);
    expect(onlyCall().params).toEqual([PHARMACY, USER]);
  });

  it('answers 0 rather than undefined when the count returns no row', async () => {
    queueRows([]);

    // `count(*)` always returns a row, so this is unreachable against Postgres —
    // but a repository that returned `undefined` here would make the last-owner
    // guard throw instead of refusing, and refusing is the safe direction.
    await expect(countActiveOwners(PHARMACY)).resolves.toBe(0);
  });
});

describe('updateStaff', () => {
  it('bumps the session version in the same statement as a role change', async () => {
    await updateStaff(USER, { role: 'staff' }, { invalidateSessions: true });

    const call = onlyCall();
    expect(call.text).toBe(
      `update users set role = $1, session_version = session_version + 1, ` +
        `updated_at = $2 where id = $3 returning ${COLUMNS}`
    );
    expect(call.params[0]).toBe('staff');
    expect(call.params[2]).toBe(USER);

    // The bump is not a separate statement, so there is no window in which the
    // role has changed and the old token still works. Two statements would also
    // be two round trips where the second could fail after the first committed.
    expect(calls).toHaveLength(1);
  });

  it('leaves the session alone when the edit changes nothing a token asserts', async () => {
    await updateStaff(USER, { fullName: 'Ama Mensah-Yirenkyi' }, { invalidateSessions: false });

    const call = onlyCall();
    expect(call.text).toBe(
      `update users set full_name = $1, updated_at = $2 where id = $3 returning ${COLUMNS}`
    );
    // Asserted against the bump expression rather than the bare column name:
    // RETURNING lists `session_version` on every one of these statements, so
    // `not.toContain('session_version')` would fail here for a reason that has
    // nothing to do with whether the session was ended.
    expect(call.text).not.toContain('session_version = session_version + 1');
    expect(call.params).toEqual(['Ama Mensah-Yirenkyi', expect.any(String), USER]);
  });

  it('numbers placeholders contiguously across every combination of columns', async () => {
    // This is the failure the whole suite exists for. `updateStaff` builds its
    // SET list dynamically, so the position of `where id = $n` depends on how
    // many values were pushed — and a value that is pushed without a
    // placeholder, or the reverse, produces SQL Postgres rejects at runtime
    // with no compile error and no test failure anywhere else.
    const patches: Array<[string, StaffPatch]> = [
      ['name only', { fullName: 'A' }],
      ['phone only', { phone: '0244000000' }],
      ['role only', { role: 'staff' }],
      ['active only', { isActive: false }],
      ['all four', { fullName: 'A', phone: null, role: 'pharmacy_owner', isActive: true }],
    ];

    for (const [label, patch] of patches) {
      for (const invalidateSessions of [true, false]) {
        calls = [];
        await updateStaff(USER, patch, { invalidateSessions });

        const call = onlyCall();
        const used = [...call.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
        const distinct = [...new Set(used)];

        // Every placeholder from 1 to the number of parameters, each one used,
        // none skipped and none out of range.
        expect({ label, invalidateSessions, distinct: distinct.sort((a, b) => a - b) }).toEqual({
          label,
          invalidateSessions,
          distinct: call.params.map((_value, index) => index + 1),
        });
        expect(Math.max(...used)).toBe(call.params.length);
      }
    }
  });

  it('puts the id last, after every value the SET clause consumed', async () => {
    await updateStaff(
      USER,
      { fullName: 'A', phone: '0244000000', role: 'staff', isActive: false },
      { invalidateSessions: true }
    );

    const call = onlyCall();
    // Four columns plus updated_at is five values, so the id is $6. The
    // session bump adds no parameter, which is exactly the off-by-one risk.
    expect(call.text).toContain('where id = $6');
    expect(call.params).toHaveLength(6);
    expect(call.params[5]).toBe(USER);
  });

  it('issues no update at all for an empty patch, and re-reads instead', async () => {
    const row = await updateStaff(USER, {}, { invalidateSessions: true });

    expect(calls.map((call) => call.text)).toEqual([
      `select ${COLUMNS} from users where id = $1`,
    ]);
    expect(row?.id).toBe(USER);
  });

  it('writes an ISO timestamp for updated_at rather than relying on a trigger', async () => {
    await updateStaff(USER, { fullName: 'A' }, { invalidateSessions: false });

    const stamped = onlyCall().params[1];
    expect(typeof stamped).toBe('string');
    expect(Number.isNaN(Date.parse(String(stamped)))).toBe(false);
  });
});

describe('setPassword', () => {
  it('changes the hash and ends the session in one statement', async () => {
    await setPassword(USER, '$2a$12$replacement');

    const call = onlyCall();
    expect(call.text).toBe(
      normalise(`
        update users
           set password_hash = $1, session_version = session_version + 1, updated_at = now()
         where id = $2
      `)
    );
    expect(call.params).toEqual(['$2a$12$replacement', USER]);

    // Whoever held the old session — including anyone who knew the old
    // password, which is the usual reason for a reset — stops here rather than
    // at token expiry.
    expect(call.text).toContain('session_version = session_version + 1');
  });
});

describe('createStaff', () => {
  const input: NewStaff = {
    pharmacyId: PHARMACY,
    fullName: 'Yaw Darko',
    email: 'yaw@aandb.example',
    phone: '0244000000',
    role: 'staff',
    passwordHash: '$2a$12$created',
  };

  it('inserts the six columns it is given and returns the row it created', async () => {
    queueRows([
      dbRow({
        id: 'a0000000-0000-4000-8000-0000000000ff',
        full_name: 'Yaw Darko',
        email: 'yaw@aandb.example',
        phone: '0244000000',
        role: 'staff',
        password_hash: '$2a$12$created',
        session_version: 0,
      }),
    ]);

    const created = await createStaff(input);

    const call = onlyCall();
    expect(call.text).toBe(
      normalise(`
        insert into users (pharmacy_id, full_name, email, phone, role, password_hash)
        values ($1, $2, $3, $4, $5, $6)
        returning ${COLUMNS}
      `)
    );
    expect(call.params).toEqual([
      PHARMACY,
      'Yaw Darko',
      'yaw@aandb.example',
      '0244000000',
      'staff',
      '$2a$12$created',
    ]);
    // The row comes back from RETURNING, so what the route answers is what the
    // database stored — including the default session_version of 0 that the
    // first issued token will have to match.
    expect(created).toEqual(
      expect.objectContaining({
        id: 'a0000000-0000-4000-8000-0000000000ff',
        email: 'yaw@aandb.example',
        role: 'staff',
        sessionVersion: 0,
      })
    );
  });

  it('does not set session_version on insert, so the column default applies', async () => {
    await createStaff(input);

    // A new account must start at the default. Setting it explicitly to
    // anything else would desynchronise it from the first token issued, and
    // that token would be refused on the very first request it was used for.
    const inserted = onlyCall().text.split(' returning ')[0] ?? '';
    expect(inserted).not.toContain('session_version');
  });

  it('translates a unique violation into a 409 the route can show', async () => {
    queueError(
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      })
    );

    const error = await createStaff(input).catch((caught: unknown) => caught);

    // The unique index is on lower(email), so a clash can only be discovered by
    // attempting the insert; pre-checking with a select is raceable and would
    // let two owners typing the same address both pass.
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    expect((error as HttpError).code).toBe('email_taken');
  });

  it('rethrows any other database error unchanged', async () => {
    // Swallowing a connection failure as "email taken" would tell the owner to
    // pick a different address when the real problem is that the database is
    // down, and they would retry forever.
    const original = Object.assign(new Error('connection terminated unexpectedly'), {
      code: '08006',
    });
    queueError(original);

    await expect(createStaff(input)).rejects.toBe(original);
  });

  it('fails loudly if the insert returns no row', async () => {
    queueRows([]);

    // INSERT ... RETURNING cannot legitimately return nothing. Reporting null
    // here would make the route answer 201 with no staff member in the body.
    await expect(createStaff(input)).rejects.toThrow(/returned no row/);
  });
});

describe('the session bookkeeping statements', () => {
  it('bumps by one, in place, with no read-modify-write', async () => {
    await bumpSessionVersion(USER);

    expect(onlyCall().text).toBe(
      'update users set session_version = session_version + 1 where id = $1'
    );
    expect(onlyCall().params).toEqual([USER]);

    // Incrementing in SQL rather than reading, adding and writing back is what
    // makes two concurrent sign-outs lose neither bump.
    expect(onlyCall().text).not.toMatch(/session_version = \$\d/);
  });

  it('stamps the login time with the database clock', async () => {
    await markLogin(USER);

    expect(onlyCall().text).toBe('update users set last_login_at = now() where id = $1');
    expect(onlyCall().params).toEqual([USER]);
  });
});

describe('no value ever reaches the statement as text', () => {
  // Parameter binding is the whole defence against injection, and it is easy to
  // lose by accident: a template literal that grows a `${value}` while somebody
  // is debugging compiles, runs, and works in every test that passes a normal
  // email address. These values are chosen so that any one of them appearing in
  // a statement is visible.
  const hostile = `'; drop table users; --`;
  const hostileEmail = `o'brien+"@aandb.example`;

  it('keeps every supplied value in the parameter list', async () => {
    await findUserByEmail(hostileEmail);
    await findUserById(hostile);
    await listStaff(hostile);
    await countActiveOwners(hostile, hostile);
    await bumpSessionVersion(hostile);
    await markLogin(hostile);
    await setPassword(hostile, hostileEmail);
    await updateStaff(
      hostile,
      { fullName: hostileEmail, phone: hostile, role: 'staff', isActive: false },
      { invalidateSessions: true }
    );
    await createStaff({
      pharmacyId: hostile,
      fullName: hostileEmail,
      email: hostileEmail,
      phone: hostile,
      role: 'staff',
      passwordHash: hostile,
    });

    expect(calls.length).toBeGreaterThan(0);

    const leaked = calls.filter(
      (call) => call.text.includes('drop table') || call.text.includes(hostileEmail)
    );
    expect(leaked.map((call) => call.text)).toEqual([]);

    // And positively: the values did travel, as parameters.
    const allParams = calls.flatMap((call) => call.params);
    expect(allParams).toContain(hostile);
    expect(allParams).toContain(hostileEmail);
  });

  it('binds the role as a parameter, not as an identifier spliced into the SQL', async () => {
    await updateStaff(USER, { role: 'pharmacy_owner' }, { invalidateSessions: false });

    // `role = $1`, never `role = pharmacy_owner`. The one place a role does
    // appear as a literal is the `countActiveOwners` filter, which is a constant
    // in the source and not reachable from a request.
    expect(onlyCall().text).toContain('role = $1');
    expect(onlyCall().text).not.toContain("'pharmacy_owner'");
  });
});

describe('the Postgres harness carries these same statements', () => {
  // Pinning SQL as text proves the repository builds what we intend, and
  // nothing more: it cannot tell us Postgres accepts it. That is what
  // `database/tests/assertions.sql` section 9 is for, which PREPAREs each of
  // these statements against a real server.
  //
  // But section 9 holds a hand copy. Left alone it drifts: somebody edits the
  // repository, the harness keeps preparing the old statement, and it goes on
  // reporting PASS while proving nothing about the code that ships. This test
  // is the tie between the two halves — it fails the moment a statement here
  // stops appearing in the harness, and says which one.
  const harnessPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'database',
    'tests',
    'assertions.sql'
  );

  /** The normalised body of every `prepare users_repo_* as ...;` in the harness. */
  function harnessStatements(): Set<string> {
    const source = fs.readFileSync(harnessPath, 'utf8');
    // Scoped to this repository's prefix. The harness prepares statements for
    // other proofs too — section 6 pins the sales enum cast — and counting those
    // as ours would let a stale users statement hide among them.
    const bodies = [...source.matchAll(/prepare\s+users_repo_\w+\s+as\s+([\s\S]*?);/g)].map(
      (match) => match[1]
    );
    if (bodies.length === 0) {
      throw new Error(
        `no \`prepare users_repo_* as\` statements found in ${harnessPath}; section 9 of the ` +
          'harness is how these statements are proven to parse against real Postgres, so ' +
          'restore it rather than deleting this test'
      );
    }
    return new Set(bodies.map((body) => normalise(body ?? '')));
  }

  /** Every statement shape the repository can emit, by driving it once each. */
  async function emittedStatements(): Promise<string[]> {
    calls = [];

    await findUserByEmail('ama@aandb.example');
    await findUserById(USER);
    await listStaff(PHARMACY);
    await countActiveOwners(PHARMACY, USER);
    await createStaff({
      pharmacyId: PHARMACY,
      fullName: 'Yaw Darko',
      email: 'yaw@aandb.example',
      phone: '0244000000',
      role: 'staff',
      passwordHash: '$2a$12$created',
    });
    // The three SET-list shapes: the bump, no bump, and the widest patch.
    await updateStaff(USER, { role: 'staff' }, { invalidateSessions: true });
    await updateStaff(USER, { fullName: 'Ama Mensah' }, { invalidateSessions: false });
    await updateStaff(
      USER,
      { fullName: 'Ama Mensah', phone: null, role: 'pharmacy_owner', isActive: true },
      { invalidateSessions: true }
    );
    await setPassword(USER, '$2a$12$replacement');
    await bumpSessionVersion(USER);
    await markLogin(USER);

    return calls.map((call) => call.text);
  }

  it('proves each of them against the harness, and fails naming any it has lost', async () => {
    const statements = await emittedStatements();
    const harness = harnessStatements();

    // Guarding the guard: if the drive above stopped issuing statements, the
    // comparison below would pass against nothing.
    expect(statements.length).toBeGreaterThanOrEqual(11);

    const missing = [...new Set(statements)].filter((statement) => !harness.has(statement));
    expect(missing).toEqual([]);
  });

  it('has no prepared statement in the harness that the repository no longer emits', async () => {
    const statements = new Set(await emittedStatements());
    const harness = harnessStatements();

    // The other direction. A prepared statement left behind after the repository
    // changed would keep the harness green for a shape nothing produces, and the
    // real shape would go unproven.
    const stale = [...harness].filter((statement) => !statements.has(statement));
    expect(stale).toEqual([]);
  });
});
