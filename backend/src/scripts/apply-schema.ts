import fs from 'fs/promises';
import path from 'path';
import { Client } from 'pg';
import { config } from '../config';
import { scoped } from '../utils/logger';

/**
 * Applies `database/init.sql` and every migration to the database named by
 * DATABASE_URL.
 *
 * This exists because the alternative is asking someone to open a SQL console
 * and paste 600 lines in the right order, which is how a pharmacy ends up with
 * a schema nobody can describe. It does not create a database — Supabase hands
 * one out — and it never drops anything.
 *
 * Safe to re-run. `init.sql` is skipped when the schema is already there, and
 * each migration is idempotent by the convention recorded in
 * `database/migrations/README.md`.
 *
 * Usage: `npm run db:apply` from `backend/` or from the repository root.
 */

const log = scoped('db:apply');

/**
 * `database/` is a sibling of `backend/`, and this file sits at the same depth
 * below it whether it runs from `src` under ts-node or from `dist` after a build
 * — `rootDir` is `src` and `outDir` is `dist`, so the compiled path mirrors the
 * source one.
 */
const DATABASE_DIR = path.resolve(__dirname, '..', '..', '..', 'database');
const MIGRATIONS_DIR = path.join(DATABASE_DIR, 'migrations');

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Migration file names, in the order they should run.
 *
 * `*.verify.sql` files are the harness's assertions about a migration, not
 * schema. Running one against a real database would execute its
 * `raise exception` blocks and either fail or prove nothing, so they are
 * excluded by name here and by grep in the Docker harness.
 *
 * Sorted lexicographically, which orders `0001` … `9999` correctly. A
 * five-digit migration number would need this revisiting; that is roughly four
 * migrations a week for twenty years.
 */
async function migrationFiles(): Promise<string[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.verify.sql'))
    .sort();
}

/**
 * Runs one SQL file in its own transaction.
 *
 * One transaction per file rather than for the whole run: a failure rolls back
 * that file and leaves the ones before it applied, so the log says something
 * true about the state of the database instead of "something went wrong".
 *
 * The cost of an explicit BEGIN is that `ALTER TYPE … ADD VALUE` cannot run
 * inside it — Postgres refuses, because the new value would be visible to other
 * sessions before the transaction decided to keep it. A migration that adds an
 * enum value must therefore be the only statement in its file. That is a
 * Postgres restriction and it is recorded here rather than discovered at 2am.
 */
async function applyFile(client: Client, label: string, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
    log.info(`applied ${label}`);
  } catch (error) {
    // A ROLLBACK that fails means the connection is gone. Reporting that instead
    // of the original error would hide the real cause, so it is swallowed and
    // the statement that actually failed is what the operator sees.
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(`${label} failed and was rolled back: ${describe(error)}`);
  }
}

async function main(): Promise<void> {
  if (config.isProduction) {
    // A schema change to a live pharmacy database is a decision, not a script
    // run. This guard stops the script from being invoked inside a production
    // container by a start command nobody read twice.
    throw new Error(
      'NODE_ENV is production. Refusing to change schema in a production process. ' +
        'Run this against the target database from a machine, with the connection string for it.'
    );
  }

  const client = new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    ssl: config.databaseSsl
      ? { rejectUnauthorized: config.databaseSslRejectUnauthorized }
      : undefined,
  });

  try {
    await client.connect();

    // `users` is the marker because it is created by init.sql, is referenced by
    // almost everything else, and cannot plausibly exist by accident.
    const marker = await client.query("select to_regclass('public.users') as users");
    const first = marker.rows[0] as { users: string | null } | undefined;
    const hasSchema = first !== undefined && first.users !== null;

    if (hasSchema) {
      log.info('schema already present — skipping init.sql');
    } else {
      const initSql = await fs.readFile(path.join(DATABASE_DIR, 'init.sql'), 'utf8');
      await applyFile(client, 'init.sql', initSql);
    }

    const migrations = await migrationFiles();
    for (const name of migrations) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      await applyFile(client, name, sql);
    }

    log.info(
      migrations.length === 1
        ? 'schema is up to date: 1 migration applied'
        : `schema is up to date: ${migrations.length} migrations applied`
    );
  } finally {
    // Closed whether or not the run succeeded, because an open client keeps the
    // process alive and `npm run db:apply` would appear to hang after printing
    // its last line.
    await client.end();
  }
}

main().catch((error: unknown) => {
  log.error(describe(error));
  process.exitCode = 1;
});
