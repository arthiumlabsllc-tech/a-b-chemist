import {
  findFrontendConfigProblems,
  normaliseApiBaseUrl,
  readFrontendConfig,
} from '../frontend-config';

/**
 * Configuration resolution for the browser bundle.
 *
 * These assert the failure that motivated the module: a build that deploys with
 * the API URL unset or pointing at localhost renders a complete-looking app that
 * talks to nobody. It is worth a suite because nothing else catches it — the
 * type checker is happy, the build succeeds, and the page renders.
 */

describe('normaliseApiBaseUrl', () => {
  it('strips a single trailing slash', () => {
    expect(normaliseApiBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
  });

  it('strips several trailing slashes', () => {
    // `${base}/pos/sales` against `https://api.example.com//` produces a path the
    // browser resolves against the page origin instead of the API.
    expect(normaliseApiBaseUrl('https://api.example.com///')).toBe('https://api.example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseApiBaseUrl('  https://api.example.com  ')).toBe('https://api.example.com');
  });

  it('leaves a URL with no trailing slash unchanged', () => {
    expect(normaliseApiBaseUrl('https://api.example.com')).toBe('https://api.example.com');
  });
});

describe('readFrontendConfig', () => {
  it('falls back to the local API when nothing is set', () => {
    const config = readFrontendConfig({});

    expect(config.apiBaseUrl).toBe('http://localhost:5000');
    expect(config.appName).toBe('A&B Chemist');
    expect(config.environment).toBe('development');
  });

  it('normalises a configured URL', () => {
    const config = readFrontendConfig({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'https://api.abchemist.example/',
    });

    expect(config.apiBaseUrl).toBe('https://api.abchemist.example');
    expect(config.environment).toBe('production');
  });

  it('takes the app name from the environment when one is given', () => {
    const config = readFrontendConfig({ NEXT_PUBLIC_APP_NAME: 'A&B Chemist — Accra' });

    expect(config.appName).toBe('A&B Chemist — Accra');
  });
});

describe('findFrontendConfigProblems', () => {
  it('reports an unset API URL and names the fallback it will use', () => {
    const problems = findFrontendConfigProblems({});

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('NEXT_PUBLIC_API_URL is not set');
    expect(problems[0]).toContain('http://localhost:5000');
  });

  it('accepts a local API in development', () => {
    expect(
      findFrontendConfigProblems({
        NODE_ENV: 'development',
        NEXT_PUBLIC_API_URL: 'http://localhost:5000',
      })
    ).toEqual([]);
  });

  it('accepts an HTTPS API in production', () => {
    expect(
      findFrontendConfigProblems({
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_URL: 'https://api.abchemist.example',
      })
    ).toEqual([]);
  });

  it('rejects a URL that is not absolute', () => {
    const problems = findFrontendConfigProblems({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'api.abchemist.example',
    });

    expect(problems.some((problem) => problem.includes('not an absolute URL'))).toBe(true);
  });

  it('rejects a scheme the browser cannot fetch', () => {
    const problems = findFrontendConfigProblems({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'ftp://api.abchemist.example',
    });

    expect(problems.some((problem) => problem.includes('must start with http'))).toBe(true);
  });

  it('rejects a production build pointed at the visitor machine', () => {
    const problems = findFrontendConfigProblems({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'http://localhost:5000',
    });

    // Both faults at once: it is loopback, and it is plaintext. Reporting only
    // one would leave the second to be discovered on the next deploy.
    expect(problems.some((problem) => problem.includes("visitor's own computer"))).toBe(true);
    expect(problems.some((problem) => problem.includes('mixed content'))).toBe(true);
  });

  it('rejects plaintext HTTP against a production host', () => {
    const problems = findFrontendConfigProblems({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'http://api.abchemist.example',
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('mixed content');
  });
});
