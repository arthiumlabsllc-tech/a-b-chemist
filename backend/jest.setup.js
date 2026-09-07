/**
 * Runs before each test file loads its modules, via `setupFiles`.
 *
 * That timing is the whole point: `config` is a singleton built the first time
 * `../config` is imported, so anything that has to influence it must be in the
 * environment before then. `setupFilesAfterEnv` would be too late.
 *
 * Every value below is pinned rather than defaulted, so the suite produces the
 * same result whether or not a developer has a `backend/.env` on their machine.
 * `dotenv` never overwrites a variable that is already set, which is what makes
 * pinning here win over the file.
 */

process.env.NODE_ENV = 'test';

// The timezone is NOT pinned here, and that is not an omission.
//
// It was, first, and the pin did nothing: `setupFiles` runs inside the test
// context, by which point V8 has already resolved that context's timezone, so
// assigning `process.env.TZ` here is too late. It lives in jest.config.js,
// which the parent process evaluates before it spawns a single worker. See the
// comment there, and `clock.test.ts`, which fails if the pin ever stops working.

// Port 1 refuses the connection immediately. A suite must never be able to reach
// a real database — not even accidentally, not even a developer's local one — and
// an unroutable hostname is both slow and non-deterministic where a refused
// connection is instant.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://probe:probe@127.0.0.1:1/probe';
}

// Long enough to satisfy the production length rule if a suite ever exercises
// it, obviously not a real secret.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'jest-access-secret-0123456789-0123456789';
}
if (!process.env.JWT_REFRESH_SECRET) {
  process.env.JWT_REFRESH_SECRET = 'jest-refresh-secret-0123456789-0123456789';
}

if (!process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN = 'http://localhost:3000';
}

// On, so the rate-limit suite can prove per-client keying the way Render
// delivers it: through X-Forwarded-For. With trust proxy off, every supertest
// request shares one socket address and the buckets cannot be told apart.
if (!process.env.TRUST_PROXY) {
  process.env.TRUST_PROXY = 'true';
}

// Removed outright, not defaulted: a key left in the environment would let a test
// reach the real gateway. Gateway behaviour is tested by passing explicit env
// objects to `buildConfig`, never by reading the process environment.
delete process.env.PAYSTACK_SECRET_KEY;
delete process.env.PAYSTACK_PUBLIC_KEY;
