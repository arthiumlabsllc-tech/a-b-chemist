jest.mock('pg', () => {
  /**
   * One client, and a new pool per construction.
   *
   * Nothing in this file may reach a socket. `jest.setup.js` points
   * `DATABASE_URL` at port 1 so a real connection is refused instantly rather
   * than succeeding against whatever database a developer happens to have
   * running — but "instantly refused" is still a test whose result depends on
   * the machine, and a suite that can fail because something is listening is a
   * suite that will one day write to it.
   *
   * The pool is rebuilt rather than shared because `closePool()` nulls the
   * module's handle and the next `getPool()` constructs again. A mock that
   * handed back the same object every time would make "a later call builds a
   * fresh one" unfalsifiable — it would pass with the caching removed and with
   * the nulling removed, and both are the behaviour under test.
   */
  const client = { query: jest.fn(), release: jest.fn() };
  const pools: { connect: jest.Mock; query: jest.Mock; on: jest.Mock; end: jest.Mock }[] = [];

  const build = (): (typeof pools)[number] => {
    const pool = { connect: jest.fn(), query: jest.fn(), on: jest.fn(), end: jest.fn() };
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
    pool.end.mockResolvedValue(undefined);
    pools.push(pool);
    return pool;
  };

  return { Pool: jest.fn(build), __client: client, __pools: pools };
});

// Mocked so `./pg-types` is never loaded: it reads `types` off the real `pg`
// module, which the mock above does not provide. What the parsers do is
// `pg-types.test.ts`; that they are registered before the first statement is a
// property of the code's shape, not something this file can assert without
// depending on which test ran first.
jest.mock('../database/pg-types', () => ({ registerPgTypeParsers: jest.fn() }));

import type { Pool, PoolClient } from 'pg';
import {
  closePool,
  getPool,
  probeDatabase,
  query,
  withSavepoint,
  withTransaction,
} from '../database/pool';

/**
 * The transaction, the savepoint and the readiness probe.
 *
 * Three pieces of plumbing that nothing else in the app can compensate for:
 *
 * - `withTransaction` is the whole of the sale write path's atomicity. A sale
 *   row without its batch decrements is stock that was sold and never left the
 *   shelf; the decrements without the sale row is stock that vanished.
 * - `withSavepoint` is what lets one bad row of a CSV import fail without
 *   taking the other four hundred with it. A plain `try/catch` cannot do that,
 *   because once a statement errors the transaction is aborted and every later
 *   statement in it fails until it is rolled back.
 * - `probeDatabase` is the difference between a hung database making Render
 *   mark this instance unhealthy and every request waiting out the full
 *   connection timeout.
 *
 * The savepoint name is the interesting one. Postgres does not accept
 * `SAVEPOINT $1`, so the name is interpolated — the only place in the codebase
 * where a value reaches SQL as text rather than as a parameter.
 */

interface FakeClient {
  query: jest.Mock;
  release: jest.Mock;
}

interface FakePool {
  connect: jest.Mock;
  query: jest.Mock;
  on: jest.Mock;
  end: jest.Mock;
}

const pgMock = jest.requireMock('pg') as {
  Pool: jest.Mock;
  __client: FakeClient;
  __pools: FakePool[];
};

const asFakePool = (pool: Pool): FakePool => pool as unknown as FakePool;

/**
 * The pool the module is holding right now, as a spy.
 *
 * Reached through `getPool()` rather than by indexing the list of constructed
 * pools, so that no test depends on an earlier one having built it first.
 */
const poolNow = (): FakePool => asFakePool(getPool());

/** A client of one's own, so statement assertions are not shared between tests. */
function fakeClient(): FakeClient {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
}

const asClient = (client: FakeClient): PoolClient => client as unknown as PoolClient;

/** The statements a client was sent, in order, without their parameters. */
const statements = (client: FakeClient): unknown[] =>
  client.query.mock.calls.map((call: unknown[]) => call[0]);

beforeEach(() => {
  // `clearMocks` empties call records between tests but leaves implementations
  // alone, so a `mockImplementation` installed by one test would otherwise
  // still be throwing in the next one. Applied to every pool built so far,
  // because `closePool()` leaves the module holding one nobody has reset.
  pgMock.__client.query.mockResolvedValue({ rows: [], rowCount: 0 });
  pgMock.__client.release.mockReturnValue(undefined);
  for (const pool of pgMock.__pools) {
    pool.connect.mockResolvedValue(pgMock.__client);
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
    pool.end.mockResolvedValue(undefined);
  }
});

describe('the savepoint name', () => {
  it('refuses a name carrying a second statement, and sends nothing at all', async () => {
    const client = fakeClient();

    await expect(
      withSavepoint(asClient(client), 'csv_row_1; DROP TABLE inventory_products', async () => {
        throw new Error('the work must not run either');
      })
    ).rejects.toThrow(/^unsafe savepoint name: /u);

    // The guard is before the statement, not around it. A check that ran after
    // `SAVEPOINT ${name}` had been sent would be a check on the error message.
    expect(client.query).not.toHaveBeenCalled();
  });

  /**
   * Written out rather than generated, because the shapes are the point: each
   * of these is a way a name that is not an identifier could arrive, and the
   * guard has to refuse all of them rather than the ones somebody thought of.
   */
  const REFUSED = [
    { name: '', why: 'nothing at all' },
    { name: 'csv_row_1; DROP TABLE inventory_products', why: 'a second statement' },
    { name: "csv_row_1' OR 1=1 --", why: 'a single quote' },
    { name: 'csv_row_1"', why: 'a double quote' },
    { name: 'csv row 1', why: 'a space' },
    { name: 'CSV_ROW_1', why: 'an uppercase letter' },
    { name: '1csv_row', why: 'a leading digit' },
    { name: 'csv-row-1', why: 'a hyphen' },
    { name: 'csv.row.1', why: 'a dot' },
    { name: 'csv_row_1\nRELEASE', why: 'a newline' },
    { name: 'csv_row_1/*', why: 'the start of a comment' },
    { name: 'c'.repeat(64), why: 'one character past the identifier limit' },
  ];

  it.each(REFUSED)('refuses a name carrying $why', async ({ name }) => {
    const client = fakeClient();

    await expect(
      withSavepoint(asClient(client), name, async () => 'never runs')
    ).rejects.toThrow('unsafe savepoint name');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('says what it refused, because the name is the only clue in the log', async () => {
    const client = fakeClient();

    // `JSON.stringify` rather than the raw text: an invisible character in a
    // name would otherwise produce an error that reads like a correct name was
    // rejected, which sends whoever is debugging in the wrong direction.
    await expect(
      withSavepoint(asClient(client), 'csv row', async () => 'never runs')
    ).rejects.toThrow('unsafe savepoint name: "csv row"');
  });

  const ACCEPTED = [
    { name: 'csv_row_1', why: 'the name the importer builds' },
    { name: 'a', why: 'a single letter' },
    { name: '_private', why: 'a leading underscore' },
    { name: 'row_0_9', why: 'digits after the first character' },
    { name: 'a'.repeat(63), why: 'exactly the identifier limit' },
  ];

  it.each(ACCEPTED)('accepts $why, and interpolates it unquoted', async ({ name }) => {
    const client = fakeClient();

    await withSavepoint(asClient(client), name, async () => undefined);

    // Unquoted and unchanged. Quoting would be a valid Postgres identifier of
    // a different name, and the release would then not find the savepoint it
    // opened — which is a leak that shows up only under a long import.
    expect(statements(client)).toEqual([`SAVEPOINT ${name}`, `RELEASE SAVEPOINT ${name}`]);
  });
});

describe('withSavepoint', () => {
  it('opens, runs the work and releases, in that order', async () => {
    const client = fakeClient();

    const result = await withSavepoint(asClient(client), 'csv_row_1', async () => 'imported');

    expect(result).toBe('imported');
    expect(statements(client)).toEqual(['SAVEPOINT csv_row_1', 'RELEASE SAVEPOINT csv_row_1']);
  });

  it('rolls back to the savepoint when a row fails, then releases it', async () => {
    const client = fakeClient();

    await expect(
      withSavepoint(asClient(client), 'csv_row_7', async () => {
        throw new Error('lot_number_required');
      })
    ).rejects.toThrow('lot_number_required');

    // Both statements, and the release last. Skipping the release is what turns
    // an import where every row fails into a transaction carrying a thousand
    // savepoints; skipping the rollback is what leaves the transaction aborted
    // and every later row failing with "current transaction is aborted".
    expect(statements(client)).toEqual([
      'SAVEPOINT csv_row_7',
      'ROLLBACK TO SAVEPOINT csv_row_7',
      'RELEASE SAVEPOINT csv_row_7',
    ]);
  });

  it('rethrows the very error the work threw, not a wrapper around it', async () => {
    const client = fakeClient();
    const failure = Object.assign(new Error('duplicate code'), { code: 'duplicate_code' });

    await expect(
      withSavepoint(asClient(client), 'csv_row_3', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    // Identity, not message. The importer decides whether a failure belongs in
    // the per-row report or should abort the whole file by looking at the error
    // it was given, and a wrapper — even one that preserves the message — makes
    // every one of those checks fail open.
  });

  it('keeps the original error when the rollback itself fails', async () => {
    const client = fakeClient();
    const failure = new Error('lot_number_required');

    client.query.mockImplementation(async (text: string) => {
      if (text === 'ROLLBACK TO SAVEPOINT csv_row_2') {
        throw new Error('connection terminated unexpectedly');
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(
      withSavepoint(asClient(client), 'csv_row_2', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    // The connection going away is a bigger problem than the bad row, but the
    // caller is mid-import and the row error is the one it can act on. The
    // rollback failure is logged, not thrown.
  });

  it('does not swallow a successful result when only the release fails', async () => {
    const client = fakeClient();

    client.query.mockImplementation(async (text: string) => {
      if (text === 'RELEASE SAVEPOINT csv_row_4') {
        throw new Error('connection terminated unexpectedly');
      }
      return { rows: [], rowCount: 0 };
    });

    // A failing release is outside the inner try, so it propagates. Pinned
    // because the opposite reading — "the work succeeded, so say so" — is the
    // one a caller would assume, and the import must not be left guessing
    // whether a row it counted as landed actually did.
    await expect(
      withSavepoint(asClient(client), 'csv_row_4', async () => 'imported')
    ).rejects.toThrow('connection terminated unexpectedly');
  });
});

describe('withTransaction', () => {
  it('begins, hands the pooled client to the work, and commits', async () => {
    const seen: PoolClient[] = [];

    const result = await withTransaction(async (client) => {
      seen.push(client);
      return 'written';
    });

    expect(result).toBe('written');
    // Identity, not shape: the same client the pool handed out. A repository
    // that received a different one would run its statements outside the
    // transaction, which compiles, runs, and quietly loses the atomicity.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(asClient(pgMock.__client));
    expect(statements(pgMock.__client)).toEqual(['BEGIN', 'COMMIT']);
  });

  it('returns the client to the pool', async () => {
    await withTransaction(async () => 'written');

    // In `finally`, so a leaked client shrinks the pool by one on every
    // failure. The till stops answering once the pool is empty, and the reason
    // is nowhere near the failure that caused it.
    expect(pgMock.__client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows when the work fails, and still releases', async () => {
    const failure = new Error('sale write failed');

    await expect(
      withTransaction(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(statements(pgMock.__client)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(pgMock.__client.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the original error when the rollback fails', async () => {
    const failure = new Error('sale write failed');

    pgMock.__client.query.mockImplementation(async (text: string) => {
      if (text === 'ROLLBACK') throw new Error('connection terminated unexpectedly');
      return { rows: [], rowCount: 0 };
    });

    await expect(
      withTransaction(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(pgMock.__client.release).toHaveBeenCalledTimes(1);
  });

  it('lets a throwing release escape, because it sits in a `finally` and not a `try`', async () => {
    pgMock.__client.release.mockImplementation(() => {
      throw new Error('client already released');
    });

    // Not asserted as passing: `release()` throwing is not handled, so this
    // documents that the leak guard is a `finally` and not a `try`. Recorded
    // because a pool that cannot release a client is a pool that is about to
    // stop answering, and the behaviour is worth knowing before it happens.
    await expect(
      withTransaction(async () => {
        throw new Error('sale write failed');
      })
    ).rejects.toThrow('client already released');
  });
});

describe('the pool', () => {
  it('is one object for the process, not one per call', async () => {
    const pool = poolNow();

    expect(getPool()).toBe(getPool());

    await query('SELECT 1');
    await query('SELECT 2');

    // Both statements went to the same pool. A pool per call is a connection
    // per call, and the limit is reached during the first busy hour.
    expect(pool.query).toHaveBeenNthCalledWith(1, 'SELECT 1', []);
    expect(pool.query).toHaveBeenNthCalledWith(2, 'SELECT 2', []);
  });

  it('passes an empty parameter list when a statement has none', async () => {
    await query('SELECT now()');

    // The driver treats a missing second argument as "no parameters" and an
    // empty array as "no parameters", so this is about the signature being
    // predictable rather than about behaviour — pinned because a repository
    // that spreads its values array relies on it.
    expect(poolNow().query).toHaveBeenCalledWith('SELECT now()', []);
  });
});

describe('probeDatabase', () => {
  it('reports healthy, with how long the database took', async () => {
    const result = await probeDatabase(1000);

    expect(result.ok).toBe(true);
    expect(poolNow().query).toHaveBeenCalledWith('SELECT 1');
    if (result.ok) {
      // A number rather than a fixed value: the point is that it is measured,
      // and asserting an exact latency would make this fail on a slow machine.
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports the database error rather than throwing it', async () => {
    poolNow().query.mockRejectedValue(new Error('connection refused'));

    const result = await probeDatabase(1000);

    // Returned, not thrown: this is called from the readiness route, and a
    // probe that throws answers 500 from the error handler instead of 503 from
    // the probe. Render treats those differently.
    expect(result).toEqual({ ok: false, error: 'connection refused' });
  });

  it('gives up after the deadline it was given', async () => {
    poolNow().query.mockReturnValue(new Promise(() => undefined));

    const result = await probeDatabase(5);

    // The query is not cancelled, deliberately: `SELECT 1` either finishes or
    // the connection is already dead, and holding a second client just to
    // cancel it would be a worse leak than the one it prevents.
    expect(result).toEqual({ ok: false, error: 'database did not answer within 5ms' });
  });

  it('reports a non-Error rejection as text instead of losing it', async () => {
    poolNow().query.mockRejectedValue('the driver gave up');

    const result = await probeDatabase(1000);

    expect(result).toEqual({ ok: false, error: 'the driver gave up' });
  });
});

describe('closePool', () => {
  it('ends the pool and lets a later call build a fresh one', async () => {
    const before = poolNow();

    await closePool();

    expect(before.end).toHaveBeenCalledTimes(1);

    // The handle is nulled before `end()` is awaited, so a request arriving
    // during shutdown gets a fresh pool rather than one that is on its way out.
    // Asserted as a different object: with the nulling removed this would hand
    // back the closing pool, and every statement on it would fail.
    expect(poolNow()).not.toBe(before);
  });

  it('survives being closed twice', async () => {
    const live = poolNow();

    await closePool();
    await closePool();

    // A shutdown hook that runs twice — SIGTERM followed by the container's
    // own grace-period handler — must not throw on the second pass, and must
    // not end a pool it has already ended.
    expect(live.end).toHaveBeenCalledTimes(1);
  });
});
