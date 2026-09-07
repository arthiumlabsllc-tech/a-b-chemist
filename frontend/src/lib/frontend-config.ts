/**
 * Resolution and validation of the build's public configuration.
 *
 * This exists because of a specific, already-lived failure: a frontend deployed
 * with `NEXT_PUBLIC_API_URL` unset renders perfectly, shows a full dashboard, and
 * every call goes to `localhost` — so the screen looks alive while nothing is
 * loaded. Diagnosing it meant opening a network tab on a production URL. Saying
 * it on the page instead takes one line.
 *
 * Only `NEXT_PUBLIC_`-prefixed variables reach the browser bundle; Next inlines
 * them at build time, so these values are fixed by the build and cannot be
 * changed by the runtime environment. `NODE_ENV` is inlined the same way, which
 * is what makes the production checks below work in client code.
 */

export interface FrontendConfig {
  /** Absolute origin of the API, with no trailing slash. */
  apiBaseUrl: string;
  appName: string;
  environment: string;
}

/**
 * The environment as this module sees it.
 *
 * Deliberately not `NodeJS.ProcessEnv`: Next augments that interface to make
 * `NODE_ENV` required, which would force every caller and every test to supply a
 * key this module treats as optional. Taking a plain record also means the
 * functions are pure — same input, same output, no ambient state.
 */
export type FrontendEnv = Record<string, string | undefined>;

const FALLBACK_API_URL = 'http://localhost:5000';

/**
 * Strips trailing slashes and returns the absolute origin.
 *
 * `http://host:5000/` plus a path built as `${base}/pos/sales` gives
 * `//pos/sales`, which the browser resolves against the current page origin
 * rather than the API. One slash, and every request quietly goes somewhere else.
 */
export function normaliseApiBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function readFrontendConfig(env: FrontendEnv = process.env): FrontendConfig {
  const configured = (env.NEXT_PUBLIC_API_URL || '').trim();
  return {
    apiBaseUrl: normaliseApiBaseUrl(configured || FALLBACK_API_URL),
    appName: (env.NEXT_PUBLIC_APP_NAME || '').trim() || 'A&B Chemist',
    environment: env.NODE_ENV || 'development',
  };
}

/**
 * What is wrong with this build's configuration. Empty when it is deployable.
 *
 * Reported rather than thrown: a page that throws during render shows a generic
 * error boundary, which is less useful than a banner naming the variable.
 */
export function findFrontendConfigProblems(
  env: FrontendEnv = process.env
): string[] {
  const problems: string[] = [];
  const isProduction = env.NODE_ENV === 'production';
  const raw = (env.NEXT_PUBLIC_API_URL || '').trim();

  if (raw === '') {
    problems.push(
      `NEXT_PUBLIC_API_URL is not set, so this build calls ${FALLBACK_API_URL}`
    );
  } else {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      url = null;
    }

    if (url === null) {
      problems.push(`NEXT_PUBLIC_API_URL "${raw}" is not an absolute URL`);
    } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`NEXT_PUBLIC_API_URL must start with http:// or https://`);
    } else if (isProduction) {
      const host = url.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
        problems.push(
          'NEXT_PUBLIC_API_URL points at this machine, so a deployed build would call the visitor\'s own computer'
        );
      }
      // A production page served over HTTPS cannot call an HTTP API: the browser
      // blocks it as mixed content, and the failure looks like a network outage
      // rather than a configuration mistake.
      if (url.protocol === 'http:') {
        problems.push('NEXT_PUBLIC_API_URL is http:// in a production build; browsers block that as mixed content');
      }
    }
  }

  return problems;
}

/**
 * The resolved configuration for this build.
 *
 * Read once at module scope so every caller sees the same value. It cannot change
 * after the build, and re-deriving it per call would only create a way for two
 * parts of the app to disagree.
 */
export const frontendConfig: FrontendConfig = readFrontendConfig();

/** Problems with this build's configuration, empty when it is deployable. */
export const frontendConfigProblems: string[] = findFrontendConfigProblems();
