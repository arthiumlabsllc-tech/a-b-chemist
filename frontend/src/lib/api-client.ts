/**
 * The one way this app talks to the API.
 *
 * A factory rather than a module-level client, for the reason the backend builds
 * its app with `createApp()`: a test can construct one against a fake `fetch` and
 * a fake token source and drive every branch, without a session, without a
 * network, and without two parts of the app holding different ideas of where the
 * API is.
 *
 * ## What it is responsible for
 *
 * - unwrapping the `{ success, data }` / `{ success, error }` envelope so no page
 *   ever has to know it exists;
 * - turning every failure — a 4xx, a 5xx, a rate limit, a proxy's HTML error
 *   page, a dead network — into one `ApiError` that says which kind it is;
 * - attaching the access token, and on a 401 refreshing once and replaying once.
 *
 * ## What it is deliberately not responsible for
 *
 * Holding a token. Where tokens live, how long they last and when to refresh
 * ahead of expiry is `auth-session.ts`; this module asks a `TokenSource` and does
 * not care. That split is also what keeps the two from importing each other.
 */

/**
 * How a request failed, which is the only distinction Phase 9's offline queue
 * needs and the one every page needs.
 *
 * - `network` — the request never got an answer. The API may be down, the
 *   tablet may be offline, DNS may have failed. Retryable, and queueable.
 * - `http` — the API answered with a status. A 4xx is not retryable and its
 *   message is for the person at the counter; a 5xx is a fault to report.
 * - `envelope` — the API answered 2xx with a body this client could not read.
 *   Kept separate from `http` because it is neither: retrying it is pointless
 *   and showing its body to a pharmacist is pointless too.
 * - `aborted` — somebody cancelled it. Not a failure, and above all not
 *   retryable: a queue that replays a request a page cancelled on unmount would
 *   ring up a sale nobody asked for.
 * - `timeout` — the client gave up waiting. Kept apart from `network` because
 *   the two mean opposite things to a queue: a request that never connected
 *   certainly did not reach the server, while one that timed out may have been
 *   processed and answered into a connection that had already dropped. Retrying
 *   the first is safe. Retrying the second can ring up two sales.
 */
export type ApiErrorKind = 'network' | 'http' | 'envelope' | 'aborted' | 'timeout';

/**
 * The two 403s that mean the account itself cannot be used. Both come from the
 * `/auth` endpoints, and neither is reachable from an authenticated route —
 * which is why any other 403 arriving here is a permission denial instead.
 */
const SESSION_ENDED_CODES: ReadonlySet<string> = new Set([
  'account_disabled',
  'password_not_set',
]);

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** Null when there was no response to have one. */
  readonly status: number | null;
  /** The backend's stable machine-readable label, when it sent one. */
  readonly code: string | undefined;
  /** Field-level validation detail, safe to show at the counter. */
  readonly details: unknown;

  constructor(
    kind: ApiErrorKind,
    message: string,
    options: { status?: number | null; code?: string; details?: unknown } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code;
    this.details = options.details;
    // Restores the prototype chain when this is compiled down to ES5-style
    // helpers, without which `instanceof ApiError` is false in a caller and
    // every deliberate failure falls through to a generic error boundary. The
    // backend's HttpError does the same and for the same reason.
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /**
   * The request never reached the API, so nothing can have happened server-side.
   * This is the case the offline queue exists for, and it is `network` alone: a
   * timeout is excluded on purpose, because a timed-out write may already have
   * been committed and a queue that replayed it would ring up a second sale.
   */
  get isOffline(): boolean {
    return this.kind === 'network';
  }

  /**
   * The session is not usable and the person has to sign in again.
   *
   * Every dead session on the authenticated request path is a 401:
   * `authenticate` answers 401 `token_invalid` even for a deactivated user, so
   * that a till cannot keep selling after the cashier was signed off.
   *
   * A bare 403 is deliberately not included, and that is the whole reason this
   * getter reads `code` rather than the status. `authorize` answers 403
   * `forbidden` to somebody who is perfectly signed in and simply lacks the
   * permission — a cashier pressing Void Sale, or the verify-payment button that
   * only the owner and the pharmacist hold. Treating that as a dead session
   * would throw the cashier out of the till for pressing a button, and it would
   * happen in the first hour of use because those five owner-only actions exist
   * to be hit. The only 403s that end a session are the two named above.
   */
  get isAuthentication(): boolean {
    if (this.status === 401) return true;
    return this.status === 403 && this.code !== undefined && SESSION_ENDED_CODES.has(this.code);
  }

  /**
   * Signed in, not allowed. Kept apart from `isAuthentication` because the
   * remedy is different and the till has to say which: "ask the owner or a
   * pharmacist to do this", not "sign in again". `details.missing` holds the
   * permissions that were refused, so a page can name the action instead of
   * showing a status code to a customer.
   */
  get isForbidden(): boolean {
    return this.status === 403 && !this.isAuthentication;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** A fault on our side of the wire, which is worth saying plainly. */
  get isServerFault(): boolean {
    return this.status !== null && this.status >= 500;
  }
}

/**
 * Where this client gets its bearer token, and what to do when one stops working.
 *
 * `refresh` is called at most once per failed request and **must** coalesce
 * concurrent calls onto one in-flight attempt. That is a requirement on the
 * implementation rather than a courtesy: `/auth/refresh` sits behind the same
 * ten-per-quarter-hour limiter as `/auth/login`, so a page that loads six
 * widgets and finds its token expired would otherwise spend six of those ten on
 * one reload and lock the counter out of signing back in.
 */
export interface TokenSource {
  getAccessToken(): string | null;
  /** True when a new access token is now available and the request may be replayed. */
  refresh(): Promise<boolean>;
  /** The session could not be saved. Sign out, and say so. */
  onUnauthenticated(): void;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  /**
   * Query parameters. `undefined` and `null` are dropped rather than sent as the
   * string "undefined", because the backend's list endpoints read an absent
   * filter as "no filter" and a present one as a value to match.
   */
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Milliseconds to wait for one attempt. Absent means no timeout.
   *
   * Ignored when `signal` is supplied, and counted per attempt rather than per
   * request, so a replay after a refresh gets a full deadline of its own.
   */
  timeoutMs?: number;
  /**
   * Whether this request carries the session. False for `/auth/login` and
   * `/auth/refresh` themselves, and for nothing else.
   *
   * Not a cosmetic flag. A refresh sent down the ordinary path would arrive
   * wearing the stale bearer token that prompted it, be answered 401, and the
   * client would respond by calling `TokenSource.refresh()` — which is the very
   * call already in flight. The coalescing that protects the rate limiter would
   * then hand it its own unresolved promise, and signing in would hang forever
   * rather than fail. Nothing in the UI could distinguish that from a dead
   * tablet.
   */
  withSession?: boolean;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  put<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  delete<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
}

export interface ApiClientOptions {
  /** Absolute origin, no trailing slash. `normaliseApiBaseUrl` produces this. */
  baseUrl: string;
  tokens: TokenSource;
  /** Injectable so a test never touches the network. */
  fetchImpl?: typeof fetch;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/**
 * Builds the query string, dropping the parameters that are not there.
 *
 * Values are stringified here rather than left to `URLSearchParams`, which would
 * turn `undefined` into the literal text `"undefined"` and send a filter the
 * backend would then try to match.
 */
export function buildQuery(
  query: RequestOptions['query']
): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/**
 * Reads a response body that may not be the JSON we asked for.
 *
 * A deployed API sits behind a proxy, and a proxy that cannot reach it answers
 * 502 with an HTML page. `response.json()` on that throws a `SyntaxError` whose
 * message is "Unexpected token '<'" — which reaches the counter as a crash and
 * sends whoever is reading it looking for a bug in the till. Saying "the API
 * answered 502 and it was not ours" is both true and actionable.
 */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('envelope', `The API answered ${response.status} with a body that was not JSON`, {
      status: response.status,
      code: 'non_json_response',
      // The first 200 characters, because a proxy's error page is mostly markup
      // and the useful part — the status line it is reporting — is at the top.
      details: text.slice(0, 200),
    });
  }
}

function toError(status: number, body: unknown): ApiError {
  // The envelope is `{ success: false, error: { message, code?, details? } }`.
  // Read defensively: a 500 from the error handler is this shape, but a 429 from
  // a proxy in front of it is not, and neither is an empty body.
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const fields = error as { message?: unknown; code?: unknown; details?: unknown };
      return new ApiError('http', typeof fields.message === 'string' ? fields.message : `Request failed with ${status}`, {
        status,
        code: typeof fields.code === 'string' ? fields.code : undefined,
        details: fields.details,
      });
    }
  }
  return new ApiError('http', `Request failed with ${status}`, { status });
}

function timeoutFailureFor(ms: number): ApiError {
  return new ApiError('timeout', `The API did not answer within ${ms}ms`, { code: 'timeout' });
}

/**
 * The cancellation for one attempt.
 *
 * Built per attempt rather than per request, because a 401 is replayed and a
 * deadline set before the first attempt would hand the replay whatever time was
 * left over — or a signal that had already fired, so the retry failed before it
 * was ever sent.
 *
 * `AbortController` and `setTimeout` rather than `AbortSignal.timeout()`, which
 * arrived in browsers years later and throws a synchronous `TypeError` from
 * inside request construction, where nothing is there to catch it. On a tablet
 * with a neglected WebView that is not a slow request; it is a till that will
 * not ring anything up at all.
 */
interface AttemptSignal {
  signal: AbortSignal | undefined;
  /** The timeout error once the deadline has passed, and null before it. */
  timeoutFailure(): ApiError | null;
  /** Clears the timer, so a page that polls does not accumulate one live timer per poll. */
  release(): void;
}

const NO_CANCELLATION: AttemptSignal = {
  signal: undefined,
  timeoutFailure: () => null,
  release: () => {},
};

function attemptSignal(caller: AbortSignal | undefined, timeoutMs: number | undefined): AttemptSignal {
  if (caller !== undefined) {
    // The caller owns cancellation for this request and `timeoutMs` is ignored
    // rather than combined with it: two owners of one request is one too many,
    // and a timeout that overwrote a page's controller would cancel navigations
    // it was never asked to cancel. Combining them properly needs
    // `AbortSignal.any()`, which is newer again than `AbortSignal.timeout()`.
    return { signal: caller, timeoutFailure: () => null, release: () => {} };
  }
  if (timeoutMs === undefined) return NO_CANCELLATION;

  const controller = new AbortController();
  const failure = timeoutFailureFor(timeoutMs);
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(failure);
  }, timeoutMs);

  return {
    signal: controller.signal,
    // `fired` is tracked rather than read off the rejection because only some
    // browsers reject `fetch` with the reason given to `abort()`. The ones that
    // discard it throw a generic AbortError, and without this a timeout on an
    // older browser would be reported as a cancellation — which a page swallows
    // silently, so the counter would watch a hung request and see nothing.
    timeoutFailure: () => (fired ? failure : null),
    release: () => clearTimeout(timer),
  };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl, tokens } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function send(path: string, init: RequestInit, token: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return fetchImpl(`${baseUrl}${path}`, { ...init, headers });
  }

  /**
   * Runs one request, refreshing and replaying at most once.
   *
   * Replaying a `POST` after a 401 is safe and the reason is worth writing down,
   * because "retry the write" is usually the wrong instinct: `authenticate` runs
   * before the route handler, so a 401 means the handler never ran and the
   * server never saw the request. There is nothing to duplicate. A 401 *after* a
   * handler started is not a thing this backend produces.
   */
  async function once(
    path: string,
    init: RequestInit,
    allowRetry: boolean,
    timeoutMs: number | undefined,
    withSession: boolean
  ): Promise<unknown> {
    const attempt = attemptSignal(init.signal ?? undefined, timeoutMs);
    try {
      let response: Response;
      try {
        response = await send(
          path,
          { ...init, signal: attempt.signal },
          withSession ? tokens.getAccessToken() : null
        );
      } catch (error) {
        // Our own timeout reason, on a browser that rejects with it.
        if (error instanceof ApiError) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
          const timedOut = attempt.timeoutFailure();
          if (timedOut !== null) throw timedOut;
          throw new ApiError('aborted', 'The request was cancelled', { code: 'aborted' });
        }
        // fetch rejects with a TypeError for every network-level failure and its
        // message varies by browser, so the message here is ours and says the one
        // thing the person at the counter needs to know.
        throw new ApiError(
          'network',
          'Cannot reach the API. Check the connection and try again.',
          { code: 'network_error', details: error instanceof Error ? error.message : String(error) }
        );
      }

      if (response.status === 401 && allowRetry && withSession) {
        const refreshed = await tokens.refresh();
        // Awaited rather than returned, so this attempt's timer is released only
        // once the replay has settled.
        if (refreshed) return await once(path, init, false, timeoutMs, withSession);
        tokens.onUnauthenticated();
        // Read the body anyway: the backend sends a message worth showing, and
        // leaving it unread would drop "This session has ended" on the floor.
        throw toError(401, await readBody(response));
      }

      const body = await readBody(response);

      if (!response.ok) {
        // Only a 401 signs the session out. A 403 here is `authorize` refusing an
        // action to somebody who is signed in, and signing them out for pressing
        // a button they do not hold would be worse than the refusal.
        if (response.status === 401 && withSession) tokens.onUnauthenticated();
        throw toError(response.status, body);
      }

      if (body === null) return undefined;

      // The success envelope. Checked rather than assumed, because a route that
      // answers with a bare object instead of `sendOk` is a bug in the backend and
      // it should be named as one here rather than surfacing as `undefined` fields
      // three components deep.
      if (typeof body === 'object' && 'success' in body && 'data' in body) {
        return (body as { success: boolean; data: unknown }).data;
      }
      throw new ApiError('envelope', 'The API answered with a body this app does not understand', {
        status: response.status,
        code: 'unexpected_envelope',
        details: body,
      });
    } finally {
      attempt.release();
    }
  }

  function prepare(
    path: string,
    requestOptions: RequestOptions
  ): {
    path: string;
    init: RequestInit;
    timeoutMs: number | undefined;
    withSession: boolean;
  } {
    const base: RequestInit = { method: requestOptions.method ?? 'GET' };

    if (requestOptions.signal !== undefined) base.signal = requestOptions.signal;

    if (requestOptions.body !== undefined) {
      base.body = JSON.stringify(requestOptions.body);
      base.headers = { ...JSON_HEADERS };
    }

    return {
      path: `${path}${buildQuery(requestOptions.query)}`,
      init: base,
      timeoutMs: requestOptions.timeoutMs,
      // Opt-out rather than opt-in: a page that forgets the flag should get the
      // ordinary authenticated behaviour, not a silent 401.
      withSession: requestOptions.withSession !== false,
    };
  }

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const prepared = prepare(path, requestOptions);
    return (await once(
      prepared.path,
      prepared.init,
      true,
      prepared.timeoutMs,
      prepared.withSession
    )) as T;
  }

  return {
    request,
    get: <T>(path: string, o: Omit<RequestOptions, 'method' | 'body'> = {}) =>
      request<T>(path, { ...o, method: 'GET' }),
    post: <T>(path: string, body?: unknown, o: Omit<RequestOptions, 'method' | 'body'> = {}) =>
      request<T>(path, { ...o, method: 'POST', body }),
    put: <T>(path: string, body?: unknown, o: Omit<RequestOptions, 'method' | 'body'> = {}) =>
      request<T>(path, { ...o, method: 'PUT', body }),
    patch: <T>(path: string, body?: unknown, o: Omit<RequestOptions, 'method' | 'body'> = {}) =>
      request<T>(path, { ...o, method: 'PATCH', body }),
    delete: <T>(path: string, o: Omit<RequestOptions, 'method' | 'body'> = {}) =>
      request<T>(path, { ...o, method: 'DELETE' }),
  };
}
