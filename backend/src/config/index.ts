import dotenv from 'dotenv';

// Read before anything else so every value below sees the file. dotenv does not
// override a variable that is already in the environment, which is what makes
// the jest setup file able to pin a black-hole DATABASE_URL and win.
dotenv.config();

/**
 * Configuration.
 *
 * Two functions rather than one, because "is this deployable" and "give me the
 * values" are different questions asked at different times. A boot that throws
 * on a missing secret is correct; a unit test that throws because nobody set
 * JWT_SECRET is noise. So problems are collected, and only production refuses to
 * start over them.
 *
 * The development fallbacks are deliberately obvious and deliberately unusable
 * as production values: `findConfigProblems` rejects them by name, not just by
 * absence, so copying a dev secret into a Render variable is caught rather than
 * quietly signing tokens everyone can forge.
 */

const DEV_JWT_SECRET = 'dev-only-not-a-secret-do-not-deploy';
const DEV_JWT_REFRESH_SECRET = 'dev-only-not-a-refresh-secret-do-not-deploy';
const MIN_SECRET_LENGTH = 32;

export type GatewayMode = 'live' | 'test' | 'unconfigured';

export interface PaystackConfig {
  publicKey: string;
  secretKey: string;
  /** Live or test, derived from the secret key prefix. Never guessed. */
  mode: GatewayMode;
  /**
   * True only when both keys are present and agree on the mode. A `pk_test_`
   * public key against an `sk_live_` secret is a real misconfiguration that
   * produces a charge the browser cannot authorise, so it is treated as not
   * configured rather than as half-working.
   *
   * There is deliberately no separate webhook secret: Paystack signs the
   * webhook body with an HMAC keyed on the secret key itself, so anything else
   * here would be a variable no gateway ever issued.
   */
  configured: boolean;
}

/**
 * SMS delivery.
 *
 * Shaped like `PaystackConfig` for the same reason: a half-configured provider
 * is worse than an absent one. Paystack's version of that is a test public key
 * against a live secret; here it is an endpoint with no key, or a key with no
 * endpoint, either of which would make every reminder fail at send time with an
 * error that reads like a network problem rather than a missing variable.
 *
 * `configured` is the only field any caller needs to branch on. `apiUrl` and
 * `apiKey` are read by the provider and by nothing else, and the key is never
 * logged — `utils/logger.ts` redaction is not something to discover the need
 * for after a secret has already been written to Render's log stream.
 */
export interface SmsConfig {
  /** The provider's sending endpoint. Empty when no provider is configured. */
  apiUrl: string;
  apiKey: string;
  /** The sender id the provider registered for A&B, where the provider uses one. */
  senderId: string;
  configured: boolean;
}

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  isTest: boolean;
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  databaseSslRejectUnauthorized: boolean;
  databasePoolMax: number;
  databaseConnectionTimeoutMs: number;
  /** Milliseconds a readiness probe waits before declaring the database down. */
  databaseProbeTimeoutMs: number;
  corsOrigins: string[];
  /**
   * Render terminates TLS and forwards, so `req.ip` is the proxy's address
   * unless this is set. Without it every request rate-limits as one client and
   * a single misbehaving tab locks the whole pharmacy out of the till.
   */
  trustProxy: boolean;
  jwt: {
    secret: string;
    refreshSecret: string;
    accessTtlSeconds: number;
    refreshTtlDays: number;
  };
  bcryptRounds: number;
  rateLimit: {
    windowMs: number;
    max: number;
    authWindowMs: number;
    authMax: number;
  };
  paystack: PaystackConfig;
  sms: SmsConfig;
  /** The Vercel origin, echoed on receipts and in emails. */
  frontendUrl: string;
}

function trimmed(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return value === undefined ? '' : value.trim();
}

function intFrom(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number
): number {
  const raw = trimmed(env, name);
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    // Falling back silently on a malformed number is how a rate limit of 10
    // becomes a rate limit of 300 and nobody notices until it is too late.
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return parsed;
}

function boolFrom(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): boolean {
  const raw = trimmed(env, name).toLowerCase();
  if (raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    // An unparseable URL is reported by findConfigProblems, not swallowed here.
    return false;
  }
}

function gatewayMode(secretKey: string): GatewayMode {
  if (secretKey.startsWith('sk_live_')) return 'live';
  if (secretKey.startsWith('sk_test_')) return 'test';
  return 'unconfigured';
}

function publicKeyMode(publicKey: string): GatewayMode {
  if (publicKey.startsWith('pk_live_')) return 'live';
  if (publicKey.startsWith('pk_test_')) return 'test';
  return 'unconfigured';
}

/**
 * Everything that would make this configuration unsafe to run in production.
 * Empty when the configuration is deployable.
 */
export function findConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const isProduction = trimmed(env, 'NODE_ENV') === 'production';
  if (!isProduction) return problems;

  const databaseUrl = trimmed(env, 'DATABASE_URL');
  if (databaseUrl === '') {
    problems.push('DATABASE_URL is required');
  } else {
    // `new URL` accepts both the `postgres://` and `postgresql://` schemes that
    // Supabase and Render hand out, so a failure to parse means a genuinely
    // malformed string rather than an unusual-but-valid one.
    try {
      new URL(databaseUrl);
    } catch {
      problems.push('DATABASE_URL is not a parseable connection string');
    }
  }

  const jwtSecret = trimmed(env, 'JWT_SECRET');
  if (jwtSecret === '') {
    problems.push('JWT_SECRET is required');
  } else if (jwtSecret === DEV_JWT_SECRET) {
    problems.push('JWT_SECRET is the development fallback and cannot sign production tokens');
  } else if (jwtSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const refreshSecret = trimmed(env, 'JWT_REFRESH_SECRET');
  if (refreshSecret === '') {
    problems.push('JWT_REFRESH_SECRET is required');
  } else if (refreshSecret === DEV_JWT_REFRESH_SECRET) {
    problems.push('JWT_REFRESH_SECRET is the development fallback and cannot sign production tokens');
  } else if (refreshSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_REFRESH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  } else if (refreshSecret === jwtSecret) {
    // One secret for both means a stolen access token can be replayed as a
    // refresh token, which turns a 1-hour compromise into a 7-day one.
    problems.push('JWT_REFRESH_SECRET must differ from JWT_SECRET');
  }

  if (trimmed(env, 'CORS_ORIGIN') === '') {
    problems.push('CORS_ORIGIN is required and must name the deployed frontend origin');
  }

  const secretKey = trimmed(env, 'PAYSTACK_SECRET_KEY');
  const publicKey = trimmed(env, 'PAYSTACK_PUBLIC_KEY');
  const secretMode = gatewayMode(secretKey);
  const publicMode = publicKeyMode(publicKey);
  if ((secretKey === '') !== (publicKey === '')) {
    problems.push('PAYSTACK_SECRET_KEY and PAYSTACK_PUBLIC_KEY must both be set or both be empty');
  } else if (secretMode !== 'unconfigured' && secretMode !== publicMode) {
    problems.push(`Paystack keys disagree: secret is ${secretMode}, public is ${publicMode}`);
  }

  // Deliberately not a production requirement. Reminders that cannot be texted
  // are still reminders: they are persisted, they appear in the bell, and they
  // are labelled `not_sent` with the reason beside them. Refusing to boot over a
  // missing SMS provider would turn an honest, visible limitation into an outage
  // of the whole till — and the pharmacy has not chosen a provider yet.
  const smsUrl = trimmed(env, 'SMS_API_URL');
  const smsKey = trimmed(env, 'SMS_API_KEY');
  if ((smsUrl === '') !== (smsKey === '')) {
    problems.push('SMS_API_URL and SMS_API_KEY must both be set or both be empty');
  } else if (smsUrl !== '' && !/^https:\/\//.test(smsUrl)) {
    // https only, and checked rather than assumed: an SMS body carries a
    // patient's name, their medicine and the fact that they are a patient at
    // all. Sending that over plaintext to a provider is a disclosure nobody
    // would choose, and a typo'd scheme is how it happens by accident.
    problems.push('SMS_API_URL must be an https URL');
  }

  return problems;
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = trimmed(env, 'NODE_ENV') || 'development';
  const isProduction = nodeEnv === 'production';

  const problems = findConfigProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `Configuration is not deployable:\n  - ${problems.join('\n  - ')}\n` +
        'Fix the environment before starting the API. Refusing to boot is the point: ' +
        'a server that starts with a development JWT secret hands out forgeable tokens.'
    );
  }

  const databaseUrl =
    trimmed(env, 'DATABASE_URL') ||
    'postgres://postgres:postgres@localhost:5432/a_and_b_chemist';

  const jwtSecret = trimmed(env, 'JWT_SECRET') || DEV_JWT_SECRET;
  const jwtRefreshSecret = trimmed(env, 'JWT_REFRESH_SECRET') || DEV_JWT_REFRESH_SECRET;

  const corsOrigins = trimmed(env, 'CORS_ORIGIN')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  const secretKey = trimmed(env, 'PAYSTACK_SECRET_KEY');
  const publicKey = trimmed(env, 'PAYSTACK_PUBLIC_KEY');
  const mode = gatewayMode(secretKey);

  const smsApiUrl = trimmed(env, 'SMS_API_URL');
  const smsApiKey = trimmed(env, 'SMS_API_KEY');

  return {
    nodeEnv,
    isProduction,
    isTest: nodeEnv === 'test',
    port: intFrom(env, 'PORT', 5000, 1),
    databaseUrl,
    // Supabase rejects plaintext connections, so SSL is on by default and only
    // a loopback database is exempt. Turning it off is an explicit act.
    databaseSsl: boolFrom(env, 'DATABASE_SSL', !isLoopback(databaseUrl)),
    databaseSslRejectUnauthorized: !boolFrom(env, 'DATABASE_SSL_ALLOW_INSECURE', false),
    databasePoolMax: intFrom(env, 'DATABASE_POOL_MAX', 10, 1),
    databaseConnectionTimeoutMs: intFrom(env, 'DATABASE_CONNECTION_TIMEOUT_MS', 10_000, 100),
    databaseProbeTimeoutMs: intFrom(env, 'DATABASE_PROBE_TIMEOUT_MS', 2_000, 100),
    corsOrigins: corsOrigins.length > 0 ? corsOrigins : ['http://localhost:3000'],
    trustProxy: boolFrom(env, 'TRUST_PROXY', isProduction),
    jwt: {
      secret: jwtSecret,
      refreshSecret: jwtRefreshSecret,
      accessTtlSeconds: intFrom(env, 'JWT_ACCESS_TTL_SECONDS', 3_600, 60),
      refreshTtlDays: intFrom(env, 'JWT_REFRESH_TTL_DAYS', 7, 1),
    },
    bcryptRounds: intFrom(env, 'BCRYPT_ROUNDS', 12, 10),
    rateLimit: {
      windowMs: intFrom(env, 'RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 1_000),
      max: intFrom(env, 'RATE_LIMIT_MAX', 300, 1),
      authWindowMs: intFrom(env, 'AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 1_000),
      authMax: intFrom(env, 'AUTH_RATE_LIMIT_MAX', 10, 1),
    },
    paystack: {
      publicKey,
      secretKey,
      mode,
      // Both keys present AND agreeing on the mode. A test public key against a
      // live secret produces a charge the browser cannot authorise, so it is
      // reported as unconfigured — the till then records mobile money manually
      // and says so, instead of handing the customer a prompt that fails.
      configured: mode !== 'unconfigured' && mode === publicKeyMode(publicKey),
    },
    sms: {
      apiUrl: smsApiUrl,
      apiKey: smsApiKey,
      senderId: trimmed(env, 'SMS_SENDER_ID'),
      // Both halves present. One without the other is a provider that fails on
      // the first message rather than one that reports itself unavailable, and
      // `services/sms.ts` reads this and nothing else to decide whether to try.
      configured: smsApiUrl !== '' && smsApiKey !== '',
    },
    frontendUrl: trimmed(env, 'FRONTEND_URL') || 'http://localhost:3000',
  };
}

/**
 * The process-wide configuration. Built once at import so a missing secret
 * stops the boot instead of surfacing as a 500 on the first request that
 * happens to need it.
 */
export const config: AppConfig = buildConfig();
