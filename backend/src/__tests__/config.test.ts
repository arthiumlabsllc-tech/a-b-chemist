import { buildConfig, config, findConfigProblems } from '../config';

/**
 * Configuration validation.
 *
 * The point of these tests is not that the parser works. It is that a
 * misconfigured production instance refuses to start rather than starting and
 * signing tokens with a development secret, or reporting a gateway as usable
 * when its keys belong to different environments. Every one of those is a
 * failure that looks like success until money or patient data is involved.
 */

const PRODUCTION_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://ab:secret@db.abchemist.example:5432/abchem',
  JWT_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  CORS_ORIGIN: 'https://app.abchemist.example',
};

function productionWith(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...PRODUCTION_ENV, ...overrides };
}

/** Asserts that at least one reported problem mentions `needle`. */
function expectProblem(env: NodeJS.ProcessEnv, needle: string): void {
  const problems = findConfigProblems(env);
  expect(problems.some((problem) => problem.includes(needle))).toBe(true);
}

describe('findConfigProblems', () => {
  it('reports nothing for a complete production environment', () => {
    expect(findConfigProblems(PRODUCTION_ENV)).toEqual([]);
  });

  it('reports nothing for a development environment with nothing set', () => {
    // A fresh clone must run without an .env. Requiring secrets in development
    // is how a README stops matching reality.
    expect(findConfigProblems({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('flags a missing DATABASE_URL in production', () => {
    const env = productionWith({ DATABASE_URL: '' });
    expectProblem(env, 'DATABASE_URL is required');
  });

  it('flags a DATABASE_URL that cannot be parsed', () => {
    const env = productionWith({ DATABASE_URL: 'not a connection string' });
    expectProblem(env, 'not a parseable connection string');
  });

  it('flags the development JWT fallback used in production', () => {
    // Rejected by name, not by absence: copying the dev value into a Render
    // variable is the mistake this exists to catch.
    const env = productionWith({ JWT_SECRET: 'dev-only-not-a-secret-do-not-deploy' });
    expectProblem(env, 'development fallback');
  });

  it('flags a JWT secret that is too short', () => {
    const env = productionWith({ JWT_SECRET: 'short' });
    expectProblem(env, 'at least 32 characters');
  });

  it('flags a refresh secret identical to the access secret', () => {
    const env = productionWith({ JWT_REFRESH_SECRET: PRODUCTION_ENV.JWT_SECRET });
    expectProblem(env, 'must differ from JWT_SECRET');
  });

  it('flags a missing CORS_ORIGIN in production', () => {
    const env = productionWith({ CORS_ORIGIN: '' });
    expectProblem(env, 'CORS_ORIGIN is required');
  });

  it('flags Paystack keys set one without the other', () => {
    const env = productionWith({ PAYSTACK_SECRET_KEY: 'sk_live_abc' });
    expectProblem(env, 'both be set or both be empty');
  });

  it('flags Paystack keys that belong to different environments', () => {
    const env = productionWith({
      PAYSTACK_SECRET_KEY: 'sk_live_abc',
      PAYSTACK_PUBLIC_KEY: 'pk_test_xyz',
    });
    expectProblem(env, 'keys disagree');
  });

  it('flags SMS settings one without the other', () => {
    expectProblem(productionWith({ SMS_API_URL: 'https://sms.example/send' }), 'SMS_API_URL');
    expectProblem(productionWith({ SMS_API_KEY: 'k' }), 'SMS_API_KEY');
  });

  it('flags a plaintext SMS endpoint', () => {
    // Not a style preference. An SMS body carries a patient's name, their
    // medicine and the fact that they are a patient at all, so a typo'd scheme
    // is a disclosure rather than an inconvenience.
    const env = productionWith({
      SMS_API_URL: 'http://sms.example/send',
      SMS_API_KEY: 'k',
    });
    expectProblem(env, 'must be an https URL');
  });

  it('does not require an SMS provider in production', () => {
    // The point of the check above being a shape check rather than a presence
    // check. A pharmacy with no provider chosen still boots, still persists its
    // reminders and still labels them not sent with the reason beside them.
    // Refusing to start would turn an honest limitation into an outage of the
    // till, which is the one thing this platform must not do.
    expect(findConfigProblems(PRODUCTION_ENV)).toEqual([]);
  });
});

describe('buildConfig', () => {
  it('refuses to build a production configuration that has problems', () => {
    expect(() => buildConfig(productionWith({ JWT_SECRET: '' }))).toThrow(
      /not deployable[\s\S]*JWT_SECRET is required/
    );
  });

  it('applies development defaults when the environment is empty', () => {
    const built = buildConfig({ NODE_ENV: 'development' });

    expect(built.isProduction).toBe(false);
    expect(built.isTest).toBe(false);
    expect(built.port).toBe(5000);
    expect(built.corsOrigins).toEqual(['http://localhost:3000']);
    expect(built.bcryptRounds).toBe(12);
    expect(built.paystack.configured).toBe(false);
    expect(built.paystack.mode).toBe('unconfigured');
    expect(built.sms.configured).toBe(false);
  });

  it('requires SSL for a hosted database and not for loopback', () => {
    const hosted = buildConfig(productionWith());
    expect(hosted.databaseSsl).toBe(true);

    const local = buildConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/abchem',
    });
    expect(local.databaseSsl).toBe(false);
  });

  it('trusts the proxy in production by default and not in development', () => {
    expect(buildConfig(productionWith()).trustProxy).toBe(true);
    expect(buildConfig({ NODE_ENV: 'development' }).trustProxy).toBe(false);
  });

  it('lets TRUST_PROXY override the default in either direction', () => {
    expect(buildConfig(productionWith({ TRUST_PROXY: 'false' })).trustProxy).toBe(false);
    expect(buildConfig({ NODE_ENV: 'development', TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('splits CORS_ORIGIN on commas and trims each entry', () => {
    const built = buildConfig({
      NODE_ENV: 'development',
      CORS_ORIGIN: 'https://a.example , https://b.example,',
    });
    expect(built.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('reports the gateway configured when both keys agree on test mode', () => {
    const built = buildConfig({
      NODE_ENV: 'development',
      PAYSTACK_SECRET_KEY: 'sk_test_abc',
      PAYSTACK_PUBLIC_KEY: 'pk_test_xyz',
    });
    expect(built.paystack.mode).toBe('test');
    expect(built.paystack.configured).toBe(true);
  });

  it('reports the gateway unconfigured when the keys disagree', () => {
    // This is the case the previous flag got wrong: both keys present, so it
    // looked configured, and every charge failed at the browser.
    const built = buildConfig({
      NODE_ENV: 'development',
      PAYSTACK_SECRET_KEY: 'sk_live_abc',
      PAYSTACK_PUBLIC_KEY: 'pk_test_xyz',
    });
    expect(built.paystack.mode).toBe('live');
    expect(built.paystack.configured).toBe(false);
  });

  it('reports the SMS provider configured only when both halves are present', () => {
    // `configured` is what `services/sms.ts` branches on and nothing else, so
    // both of its inputs have to be pinned rather than one being inferred.
    const both = buildConfig({
      NODE_ENV: 'development',
      SMS_API_URL: 'https://sms.example/send',
      SMS_API_KEY: 'k',
      SMS_SENDER_ID: 'ABCHEM',
    });
    expect(both.sms).toEqual({
      apiUrl: 'https://sms.example/send',
      apiKey: 'k',
      senderId: 'ABCHEM',
      configured: true,
    });

    const urlOnly = buildConfig({
      NODE_ENV: 'development',
      SMS_API_URL: 'https://sms.example/send',
    });
    expect(urlOnly.sms.configured).toBe(false);

    const keyOnly = buildConfig({ NODE_ENV: 'development', SMS_API_KEY: 'k' });
    expect(keyOnly.sms.configured).toBe(false);
  });

  it('names the variable when a numeric setting is malformed', () => {
    // Falling back silently on a typo is how a rate limit of 10 becomes 300 and
    // nobody notices until the till is being hammered.
    expect(() => buildConfig({ NODE_ENV: 'development', PORT: 'five-thousand' })).toThrow(
      /PORT must be an integer/
    );
    expect(() =>
      buildConfig({ NODE_ENV: 'development', BCRYPT_ROUNDS: '4' })
    ).toThrow(/BCRYPT_ROUNDS must be an integer >= 10/);
  });
});

describe('the process-wide config under jest', () => {
  it('is built from the pinned test environment', () => {
    // Pins jest.setup.js: if a developer's backend/.env ever started leaking into
    // the suite, these are the assertions that would move.
    expect(config.isTest).toBe(true);
    expect(config.isProduction).toBe(false);
    expect(config.databaseUrl).toContain('127.0.0.1:1');
    expect(config.databaseSsl).toBe(false);
    expect(config.corsOrigins).toEqual(['http://localhost:3000']);
  });

  it('has no gateway keys, so no test can reach a real charge', () => {
    expect(config.paystack.configured).toBe(false);
    expect(config.paystack.secretKey).toBe('');
    expect(config.paystack.publicKey).toBe('');
  });

  it('has no SMS provider, so no test can text a real patient', () => {
    // The sharper version of the same concern as the gateway above. A charge
    // that reaches a test gateway costs nothing; a reminder that reaches a real
    // handset sends somebody's medicine and their status as a patient to a
    // number they may have given to a different pharmacy years ago. Pinned here
    // rather than left to jest.setup.js, because the assertion belongs beside
    // the code that would fail if the pinning ever stopped working.
    expect(config.sms.configured).toBe(false);
    expect(config.sms.apiUrl).toBe('');
    expect(config.sms.apiKey).toBe('');
  });
});
