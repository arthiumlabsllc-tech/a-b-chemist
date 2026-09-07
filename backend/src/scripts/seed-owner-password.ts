import { config } from '../config';
import { closePool } from '../database/pool';
import { findUserByEmail, setPassword } from '../repositories/users.repository';
import { scoped } from '../utils/logger';
import {
  hashPassword,
  isBcryptHash,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from '../utils/password';

/**
 * Gives the seeded owner account a password.
 *
 * `database/init.sql` inserts the owner with `password_hash = 'UNSET'`, which
 * is not a hash and cannot be verified — login answers `password_not_set` for
 * it. That is deliberate: a seed file that shipped a real password would ship a
 * password into every environment, including one on the public internet. So the
 * account exists but cannot be entered until this script runs, and this script
 * is how the chicken-and-egg is resolved — the staff-management route that would
 * normally set a password needs an owner token, which needs a password.
 *
 * Usage, from `backend/` or the repository root:
 *
 *     OWNER_PASSWORD='...' npm run db:seed
 *     OWNER_EMAIL='someone@example.com' OWNER_PASSWORD='...' npm run db:seed
 *     OWNER_PASSWORD='...' npm run db:seed -- --force
 *
 * On Windows PowerShell the same three runs are:
 *
 *     $env:OWNER_PASSWORD='...'; npm run db:seed
 *     $env:OWNER_EMAIL='someone@example.com'; $env:OWNER_PASSWORD='...'; npm run db:seed
 *     $env:OWNER_PASSWORD='...'; npm run db:seed -- --force
 *
 * Re-run with `--force` to replace a password that has been forgotten.
 */

const log = scoped('db:seed');

/** The address `init.sql` seeds. Overridable so a real one can replace it. */
const DEFAULT_OWNER_EMAIL = 'owner@localhost';

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  const email = (process.env.OWNER_EMAIL || DEFAULT_OWNER_EMAIL).trim();
  const password = process.env.OWNER_PASSWORD;
  const force = process.argv.includes('--force');

  if (password === undefined || password.trim() === '') {
    throw new Error(
      'OWNER_PASSWORD is required, and is read from the environment rather than an argument: ' +
        'an argument is stored in shell history and is visible in the process list to anyone on this machine.'
    );
  }
  // Length, not strength. The same rule the API applies, so a password set here
  // could also have been set through the staff page later.
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `OWNER_PASSWORD must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`
    );
  }

  const row = await findUserByEmail(email);
  if (row === null) {
    throw new Error(
      `no user with the email ${email} exists. Run npm run db:apply first, or set OWNER_EMAIL to the address you seeded.`
    );
  }
  if (row.role !== 'pharmacy_owner') {
    // Not a restriction for its own sake. This script is the bootstrap for the
    // first account; every other password is set by an owner through
    // POST /staff/:id/reset-password, where the change is attributable to
    // somebody instead of to a shell.
    throw new Error(
      `${email} has the role ${row.role}, not pharmacy_owner. Use POST /staff/:id/reset-password as an owner instead.`
    );
  }
  if (isBcryptHash(row.passwordHash) && !force) {
    throw new Error(
      `${email} already has a password. Re-run with --force to replace it — that ends every session the account holds, ` +
        'including on any device left signed in.'
    );
  }

  await setPassword(row.id, await hashPassword(password, config.bcryptRounds));

  // The password is never logged, at any level, in any format. What is logged is
  // the two facts an operator needs afterwards: which account changed, and that
  // its outstanding sessions are gone.
  log.info(
    `password set for ${row.email} (${row.role}); previous sessions for that account are ended`
  );
}

main()
  .catch((error: unknown) => {
    log.error(describe(error));
    process.exitCode = 1;
  })
  .finally(() =>
    // The repository goes through the shared pool, and an idle pooled client
    // holds the event loop open. Without this the script prints its result and
    // then sits there for thirty seconds until the idle timeout fires.
    closePool()
  );
