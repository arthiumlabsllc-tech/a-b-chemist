import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config';
import { scoped } from '../utils/logger';
import { registerPgTypeParsers } from './pg-types';

const log = scoped('db');

/**
 * The single connection pool for the process.
 *
 * Created lazily rather than at import, because constructing a `Pool` is cheap
 * but a module that connects on import makes every unit test dependent on a
 * database being up. Nothing here opens a socket until the first query.
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool === null) {
    // Before the first connection, so no query can be issued under the default
    // parsers. See ./pg-types for what is overridden and why a Postgres `date`
    // must not arrive as a JS Date.
    registerPgTypeParsers();

    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
      ssl: config.databaseSsl
        ? { rejectUnauthorized: config.databaseSslRejectUnauthorized }
        : undefined,
    });

    // An idle client that the far end closed — Supabase recycles connections and
    // the pooled host drops them on an idle timeout — surfaces here and nowhere
    // else. Without this handler it is an uncaughtException, which takes the
    // process down in the middle of whatever sale it was serving.
    pool.on('error', (error) => {
      log.error('idle client error', { error: error.message });
    });
  }
  return pool;
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/**
 * Anything that can run a parameterised statement: the pool, or one client
 * checked out of it inside a transaction.
 *
 * Repositories that must work both ways take this as a parameter rather than
 * importing `query`. The alternative — an optional trailing `client?` — is a
 * silent atomicity bug waiting to happen: a caller that forgets the argument
 * still compiles, still runs, and quietly performs the write outside the
 * transaction that was supposed to make it all-or-nothing. A required first
 * parameter makes every call site choose.
 */
export interface Sql {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<T>>;
}

/** The pool, as a `Sql`. For reads and single-statement writes. */
export const poolSql: Sql = { query };

/**
 * Runs `work` inside a transaction and commits only if it returns normally.
 *
 * The sale write path depends on this being all-or-nothing: a sale row without
 * its batch decrements is stock that has been sold and not removed, and a batch
 * decrement without the sale row is stock that has vanished.
 */
export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // ROLLBACK fails when the connection itself is gone. Logging that and
      // rethrowing the original keeps the error that actually matters; replacing
      // it would report a rollback problem where the real fault was elsewhere.
      log.error('rollback failed', {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    throw error;
  } finally {
    // Released in `finally` because a leaked client shrinks the pool by one on
    // every failure, and the till stops answering once the pool is empty.
    client.release();
  }
}

/**
 * Savepoint names are interpolated into the statement, because Postgres does not
 * accept `SAVEPOINT $1`. That makes this the one place in the codebase where a
 * value reaches SQL as text rather than as a parameter, so it is checked here
 * rather than trusted from the caller — the caller builds the name from a row
 * index today, and nothing about the signature says it will tomorrow.
 *
 * Lowercase letters, digits and underscores, starting with a letter or
 * underscore, at most 63 bytes: a valid Postgres identifier that needs no
 * quoting and can carry no statement of its own.
 */
const SAVEPOINT_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Runs `work` inside a savepoint, rolling back to it on failure.
 *
 * This is what lets one bad row of a CSV import fail without taking the other
 * four hundred with it. A plain `try/catch` cannot do that: once a statement
 * errors, the transaction is aborted and every later statement in it fails with
 * "current transaction is aborted" until it is rolled back — and rolling the
 * whole thing back is precisely what the import must not do.
 *
 * The savepoint is released on both paths. Left alone, an import where every
 * row fails would stack one savepoint per row on the transaction.
 */
export async function withSavepoint<T>(
  client: PoolClient,
  name: string,
  work: () => Promise<T>
): Promise<T> {
  if (!SAVEPOINT_NAME.test(name)) {
    throw new Error(`unsafe savepoint name: ${JSON.stringify(name)}`);
  }

  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await work();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
    } catch (rollbackError) {
      // Same reasoning as `withTransaction`: if the connection has gone, the
      // original error is the one that matters and must not be replaced.
      log.error('savepoint rollback failed', {
        savepoint: name,
        error:
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    throw error;
  }
}

/**
 * Answers within `timeoutMs` or reports failure. Used by the readiness probe.
 *
 * The query is not cancelled when the race is lost — `SELECT 1` finishes or the
 * connection is already dead, and holding a second client just to cancel it
 * would be worse than the leak. The deadline exists so a hung database makes
 * Render mark this instance unhealthy instead of making every request wait out
 * the full connection timeout.
 */
export async function probeDatabase(
  timeoutMs: number = config.databaseProbeTimeoutMs
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`database did not answer within ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    await Promise.race([getPool().query('SELECT 1'), deadline]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function closePool(): Promise<void> {
  if (pool === null) return;
  const closing = pool;
  // Nulled before awaiting `end()` so a request arriving during shutdown gets a
  // fresh pool rather than a handle that is on its way out.
  pool = null;
  await closing.end();
}
