import { ApiError, buildQuery, createApiClient, type TokenSource } from '../api-client';

/**
 * The API client, driven against a fake `fetch` and a fake token source.
 *
 * Everything here is a decision a page cannot make for itself: which failures
 * may be retried, which end a session, and what a request looks like on the
 * wire. Phase 9's offline queue reads `kind` to decide whether to queue, so a
 * misclassification is not a cosmetic error — it is either a duplicated sale or
 * a lost one.
 */

interface Call {
  url: string;
  init: RequestInit;
}

type ScriptStep = Response | Error | ((call: Call) => Response | Error);

function jsonResponse(status: number, body: unknown): Response {
  return rawResponse(status, JSON.stringify(body));
}

function rawResponse(status: number, text: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
  } as unknown as Response;
}

/** A 2xx with no body at all, which the client must not mistake for a broken envelope. */
function emptyResponse(status = 204): Response {
  return rawResponse(status, '');
}

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function fetchFake(script: ScriptStep[]): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];

  const impl = (async (url: string, init: RequestInit = {}) => {
    const call: Call = { url: String(url), init };
    calls.push(call);

    const step = script[calls.length - 1];
    if (step === undefined) {
      // Loud rather than a hung test: an extra fetch call is the finding.
      throw new Error(`fetch was called ${calls.length} time(s) but the script had ${script.length}`);
    }
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(call) : step;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

/**
 * A fetch that never answers on its own and rejects when its signal aborts,
 * which is what a real `fetch` does.
 *
 * `discardsReason` covers the two browser behaviours that exist: modern ones
 * reject with the reason handed to `abort()`, older ones throw it away and
 * reject with a generic AbortError. The client has to read a timeout correctly
 * under both, and a test that only exercised whichever jsdom happens to
 * implement would leave the other path unproven.
 */
function hangingFetch(discardsReason: boolean): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];

  const impl = ((url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });

    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal === null || signal === undefined) return;
      const onAbort = () => reject(discardsReason ? abortError() : signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

interface TokenFake extends TokenSource {
  access: string | null;
  refreshCalls: number;
  unauthenticatedCalls: number;
  outcomes: boolean[];
}

/**
 * A token source whose `refresh()` answers from a script, and which renames the
 * access token each time it succeeds so a test can see which token a replay used.
 */
function tokenFake(access: string | null = 'access-1', outcomes: boolean[] = []): TokenFake {
  return {
    access,
    refreshCalls: 0,
    unauthenticatedCalls: 0,
    outcomes,
    getAccessToken() {
      return this.access;
    },
    async refresh() {
      const outcome = this.outcomes[this.refreshCalls] ?? false;
      this.refreshCalls += 1;
      if (outcome) this.access = `refreshed-${this.refreshCalls}`;
      return outcome;
    },
    onUnauthenticated() {
      this.unauthenticatedCalls += 1;
    },
  };
}

function nth(calls: Call[], index: number): Call {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`expected at least ${index + 1} fetch call(s), saw ${calls.length}`);
  }
  return call;
}

function headersOf(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

/**
 * Awaits a request that must fail, and insists the failure is an `ApiError`.
 *
 * Returning anything else is itself a failure worth naming: a test written as
 * `await expect(…).rejects.toThrow()` passes just as happily on a `TypeError`
 * from a bug in the client, which is the opposite of what this suite is for.
 */
async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw new Error(
      `expected an ApiError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
    );
  }
  throw new Error('expected the request to fail, and it succeeded');
}

const BASE = 'https://api.abchemist.example';

function clientFor(script: ScriptStep[], tokens: TokenFake = tokenFake()) {
  const { impl, calls } = fetchFake(script);
  return { client: createApiClient({ baseUrl: BASE, tokens, fetchImpl: impl }), calls, tokens };
}

describe('the success envelope', () => {
  it('hands back the data and nothing else', async () => {
    const { client } = clientFor([jsonResponse(200, { success: true, data: { id: 'sale-1' } })]);

    await expect(client.get<{ id: string }>('/pos/sales/sale-1')).resolves.toEqual({ id: 'sale-1' });
  });

  it('calls the API where it was configured, not relative to the page', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: [] })]);

    await client.get('/inventory/products');

    // A relative URL would resolve against the frontend's own origin, which is
    // how a deployed till ends up requesting its pages from the API host.
    expect(nth(calls, 0).url).toBe(`${BASE}/inventory/products`);
  });

  it('resolves undefined for a 2xx with no body, rather than calling it broken', async () => {
    const { client } = clientFor([emptyResponse()]);

    await expect(client.post('/pos/sales/sale-1/void', { reason: 'Customer changed their mind' }))
      .resolves.toBeUndefined();
  });

  it('names a 2xx that is not the envelope as a fault in the API', async () => {
    // A route that answers with a bare object instead of `sendOk`. Caught here,
    // at the boundary, rather than surfacing as `undefined` fields in a component.
    const { client } = clientFor([jsonResponse(200, { id: 'sale-1' })]);

    const error = await failureOf(client.get('/pos/sales/sale-1'));

    expect(error.kind).toBe('envelope');
    expect(error.code).toBe('unexpected_envelope');
    expect(error.status).toBe(200);
    expect(error.details).toEqual({ id: 'sale-1' });
  });

  it('insists on `data` being present, not merely on `success`', async () => {
    const { client } = clientFor([jsonResponse(200, { success: true })]);

    const error = await failureOf(client.get('/pos/sales'));

    expect(error.kind).toBe('envelope');
    expect(error.code).toBe('unexpected_envelope');
  });
});

describe('what goes on the wire', () => {
  it('always asks for JSON', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: null })]);

    await client.get('/tax/settings');

    expect(headersOf(nth(calls, 0)).accept).toBe('application/json');
  });

  it('sends the access token as a bearer header', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: null })]);

    await client.get('/auth/me');

    expect(headersOf(nth(calls, 0)).authorization).toBe('Bearer access-1');
  });

  it('omits the header entirely when there is no token', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: null })], tokenFake(null));

    await client.get('/auth/me');

    // Not `Bearer null`, which the backend would try to verify as a token and
    // report as an invalid one instead of an absent one.
    expect('authorization' in headersOf(nth(calls, 0))).toBe(false);
  });

  it('serialises a body as JSON and says so in the content type', async () => {
    const { client, calls } = clientFor([jsonResponse(201, { success: true, data: { id: 'sale-1' } })]);

    await client.post('/pos/sales', { lines: [{ productId: 'p-1', quantity: 2 }] });

    const call = nth(calls, 0);
    expect(headersOf(call)['content-type']).toBe('application/json');
    expect(call.init.body).toBe(JSON.stringify({ lines: [{ productId: 'p-1', quantity: 2 }] }));
  });

  it('sends the method each shorthand names', async () => {
    const ok = jsonResponse(200, { success: true, data: null });
    const { client, calls } = clientFor([ok, ok, ok, ok, ok]);

    await client.get('/a');
    await client.post('/b', {});
    await client.put('/c', {});
    await client.patch('/d', {});
    await client.delete('/e');

    expect(calls.map((call) => call.init.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });

  it('sends no body for a GET, so a proxy cannot discard the request', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: null })]);

    await client.get('/reports/sales-summary');

    expect(nth(calls, 0).init.body).toBeUndefined();
  });
});

describe('buildQuery', () => {
  it('drops undefined and null instead of sending them as text', () => {
    // `URLSearchParams` on its own would produce `status=undefined`, and the
    // backend reads a present filter as a value to match — so an unset filter
    // would silently match nothing.
    expect(buildQuery({ status: undefined, search: null, page: 2 })).toBe('?page=2');
  });

  it('is empty when every parameter was dropped', () => {
    expect(buildQuery({ status: undefined, search: null })).toBe('');
  });

  it('is empty when there are no parameters', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({})).toBe('');
  });

  it('stringifies numbers and booleans', () => {
    expect(buildQuery({ page: 1, inStock: true, includeInactive: false })).toBe(
      '?page=1&inStock=true&includeInactive=false'
    );
  });

  it('encodes a search so a separator inside it cannot split the query', () => {
    const search = 'paracetamol 500mg & syrup';
    const query = buildQuery({ search });

    expect(query).toContain('%26');
    // The property that matters: the backend reads back exactly what was typed.
    expect(new URLSearchParams(query.slice(1)).get('search')).toBe(search);
  });
});

describe('query parameters on a real request', () => {
  it('appends them to the path', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: [] })]);

    await client.get('/pos/sales', { query: { from: '2026-09-01', tender: 'momo' } });

    expect(nth(calls, 0).url).toBe(`${BASE}/pos/sales?from=2026-09-01&tender=momo`);
  });

  it('leaves a path with a query of its own alone when none are given', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: [] })]);

    await client.get('/inventory/batches?low=true');

    expect(nth(calls, 0).url).toBe(`${BASE}/inventory/batches?low=true`);
  });
});

describe('how a failure is classified', () => {
  it('reports a dead network as offline, keeping the browser message as detail', async () => {
    const { client } = clientFor([new TypeError('Failed to fetch')]);

    const error = await failureOf(client.get('/pos/sales'));

    expect(error.kind).toBe('network');
    expect(error.isOffline).toBe(true);
    expect(error.status).toBeNull();
    expect(error.code).toBe('network_error');
    // Ours, because fetch's varies by browser and none of them mention the till.
    expect(error.message).toContain('Cannot reach the API');
    expect(error.details).toBe('Failed to fetch');
  });

  it('reports a cancellation as aborted, and never as offline', async () => {
    const { client } = clientFor([abortError()]);

    const error = await failureOf(client.get('/pos/sales'));

    expect(error.kind).toBe('aborted');
    expect(error.code).toBe('aborted');
    // The queue must not replay this: a page unmounting mid-sale would
    // otherwise ring up a sale nobody asked for.
    expect(error.isOffline).toBe(false);
    expect(error.isServerFault).toBe(false);
  });

  it('reports a 4xx with the message and code the backend sent', async () => {
    const { client } = clientFor([
      jsonResponse(400, {
        success: false,
        error: {
          message: 'Quantity must be greater than zero',
          code: 'validation_failed',
          details: { fields: { quantity: 'must be positive' } },
        },
      }),
    ]);

    const error = await failureOf(client.post('/pos/sales', {}));

    expect(error.kind).toBe('http');
    expect(error.status).toBe(400);
    expect(error.message).toBe('Quantity must be greater than zero');
    expect(error.code).toBe('validation_failed');
    expect(error.details).toEqual({ fields: { quantity: 'must be positive' } });
    expect(error.isOffline).toBe(false);
  });

  it('names the status when an error arrives without the envelope', async () => {
    // A 429 from a proxy in front of the API is not shaped like ours.
    const { client } = clientFor([jsonResponse(429, { message: 'slow down' })]);

    const error = await failureOf(client.get('/reports/sales-summary'));

    expect(error.message).toBe('Request failed with 429');
    expect(error.code).toBeUndefined();
    expect(error.isRateLimited).toBe(true);
    expect(error.isServerFault).toBe(false);
  });

  it('reports a 5xx as a fault on our side of the wire', async () => {
    const { client } = clientFor([
      jsonResponse(500, { success: false, error: { message: 'Something went wrong' } }),
    ]);

    const error = await failureOf(client.get('/reports/profitability'));

    expect(error.status).toBe(500);
    expect(error.isServerFault).toBe(true);
    expect(error.isOffline).toBe(false);
  });

  it('says plainly when the API answered with something that was not JSON', async () => {
    const page = `<html><head><title>502 Bad Gateway</title></head><body>${'x'.repeat(400)}</body></html>`;
    const { client } = clientFor([rawResponse(502, page)]);

    const error = await failureOf(client.get('/pos/sales'));

    expect(error.kind).toBe('envelope');
    expect(error.code).toBe('non_json_response');
    // Not "Unexpected token '<'", which sends whoever reads it looking for a bug
    // in the till instead of at the proxy.
    expect(error.message).toBe('The API answered 502 with a body that was not JSON');
    expect(String(error.details)).toHaveLength(200);
    expect(String(error.details)).toContain('502 Bad Gateway');
  });

  it('is an Error, so a boundary and a catch block both see it', async () => {
    const { client } = clientFor([jsonResponse(500, { success: false, error: { message: 'x' } })]);

    const error = await failureOf(client.get('/pos/sales'));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.stack).toContain('ApiError');
  });
});

describe('which 403 ends a session', () => {
  it('treats a 401 as a dead session', async () => {
    const { client } = clientFor([
      jsonResponse(401, { success: false, error: { message: 'Session expired', code: 'token_invalid' } }),
    ], tokenFake('access-1', [false]));

    const error = await failureOf(client.get('/pos/sales'));

    expect(error.isAuthentication).toBe(true);
    expect(error.isForbidden).toBe(false);
  });

  it('treats a permission denial as a live session, not a dead one', async () => {
    // `authorize` answers this to somebody who is signed in and simply lacks the
    // permission — a cashier pressing Void Sale. Signing them out for it would
    // happen in the first hour of use, because the owner-only actions exist to
    // be hit by the wrong person.
    const { client, tokens } = clientFor([
      jsonResponse(403, {
        success: false,
        error: {
          message: 'Your role does not permit this action',
          code: 'forbidden',
          details: { missing: ['sales:void'] },
        },
      }),
    ]);

    const error = await failureOf(client.post('/pos/sales/sale-1/void', {}));

    expect(error.isAuthentication).toBe(false);
    expect(error.isForbidden).toBe(true);
    // So the till can name the action instead of showing a status code.
    expect(error.details).toEqual({ missing: ['sales:void'] });
    expect(tokens.unauthenticatedCalls).toBe(0);
  });

  it('treats a deactivated account as a dead session', async () => {
    const { client } = clientFor([
      jsonResponse(403, { success: false, error: { message: 'Ask the owner', code: 'account_disabled' } }),
    ]);

    const error = await failureOf(client.post('/auth/login', {}));

    expect(error.isAuthentication).toBe(true);
    expect(error.isForbidden).toBe(false);
  });

  it('does not assume a 403 with no code is one of ours', async () => {
    const { client } = clientFor([rawResponse(403, '')]);

    const error = await failureOf(client.get('/pos/sales'));

    expect(error.isAuthentication).toBe(false);
    expect(error.isForbidden).toBe(true);
  });
});

describe('refreshing on a 401', () => {
  it('refreshes once and replays with the new token', async () => {
    const { client, calls, tokens } = clientFor(
      [
        jsonResponse(401, { success: false, error: { message: 'Session expired', code: 'token_invalid' } }),
        jsonResponse(200, { success: true, data: { id: 'sale-1' } }),
      ],
      tokenFake('access-1', [true])
    );

    await expect(client.get<{ id: string }>('/pos/sales/sale-1')).resolves.toEqual({ id: 'sale-1' });

    expect(calls).toHaveLength(2);
    expect(tokens.refreshCalls).toBe(1);
    expect(headersOf(nth(calls, 0)).authorization).toBe('Bearer access-1');
    expect(headersOf(nth(calls, 1)).authorization).toBe('Bearer refreshed-1');
  });

  it('ends the session when the refresh fails, without a second request', async () => {
    const { client, calls, tokens } = clientFor(
      [jsonResponse(401, { success: false, error: { message: 'This session has ended', code: 'session_revoked' } })],
      tokenFake('access-1', [false])
    );

    const error = await failureOf(client.get('/pos/sales'));

    expect(calls).toHaveLength(1);
    expect(tokens.refreshCalls).toBe(1);
    expect(tokens.unauthenticatedCalls).toBe(1);
    // The body is still read, so "This session has ended" is not dropped.
    expect(error.message).toBe('This session has ended');
    expect(error.status).toBe(401);
  });

  it('stops after one replay: a second 401 ends the session rather than looping', async () => {
    const expired = jsonResponse(401, {
      success: false,
      error: { message: 'Session expired', code: 'token_invalid' },
    });
    const { client, calls, tokens } = clientFor([expired, expired], tokenFake('access-1', [true, true]));

    const error = await failureOf(client.get('/pos/sales'));

    // Two requests and one refresh, even though `refresh()` would have kept
    // succeeding. A loop here would spend the auth limiter's ten attempts in
    // seconds and lock the counter out of signing back in.
    expect(calls).toHaveLength(2);
    expect(tokens.refreshCalls).toBe(1);
    expect(tokens.unauthenticatedCalls).toBe(1);
    expect(error.status).toBe(401);
  });

  it('replays a write with a byte-identical body', async () => {
    const basket = { lines: [{ productId: 'p-1', quantity: 2, unitPrice: '12.50' }], tender: 'momo' };
    const { client, calls } = clientFor(
      [
        jsonResponse(401, { success: false, error: { message: 'Session expired', code: 'token_invalid' } }),
        jsonResponse(201, { success: true, data: { id: 'sale-1' } }),
      ],
      tokenFake('access-1', [true])
    );

    await client.post('/pos/sales', basket);

    // Safe to replay because `authenticate` runs before the handler: a 401 means
    // the handler never ran, so there is nothing to duplicate. The same object is
    // reused rather than re-serialised, so the replay cannot drift from the
    // original — a different key order would be a different signature to any
    // idempotency check added later.
    expect(nth(calls, 1).init.method).toBe('POST');
    expect(nth(calls, 1).init.body).toBe(nth(calls, 0).init.body);
    expect(nth(calls, 1).init.body).toBe(JSON.stringify(basket));
  });

  it('does not refresh on a permission denial', async () => {
    const { client, calls, tokens } = clientFor([
      jsonResponse(403, { success: false, error: { message: 'Not permitted', code: 'forbidden' } }),
    ], tokenFake('access-1', [true]));

    await failureOf(client.post('/pos/sales/sale-1/void', {}));

    // A new token would not change the answer, and asking for one would spend a
    // tenth of the quarter-hour's allowance on a request that was correctly refused.
    expect(tokens.refreshCalls).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('does not refresh on a server fault', async () => {
    const { client, tokens } = clientFor(
      [jsonResponse(500, { success: false, error: { message: 'Something went wrong' } })],
      tokenFake('access-1', [true])
    );

    await failureOf(client.get('/reports/sales-summary'));

    expect(tokens.refreshCalls).toBe(0);
  });
});

describe('who owns the abort signal', () => {
  it('attaches a timeout when one was asked for and no signal was supplied', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: null })]);

    await client.get('/reports/sales-summary', { timeoutMs: 5_000 });

    expect(nth(calls, 0).init.signal).toBeDefined();
  });

  it('leaves a caller-supplied signal alone even when a timeout was asked for', async () => {
    const controller = new AbortController();
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: null })]);

    await client.get('/reports/sales-summary', { signal: controller.signal, timeoutMs: 5_000 });

    // Two owners of one request is one too many: a timeout that replaced the
    // page's controller would cancel navigations it was never asked to cancel.
    expect(nth(calls, 0).init.signal).toBe(controller.signal);
  });

  it('passes a caller signal through when there is no timeout', async () => {
    const controller = new AbortController();
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: null })]);

    await client.get('/pos/products', { signal: controller.signal });

    expect(nth(calls, 0).init.signal).toBe(controller.signal);
  });

  it('attaches no signal when neither was asked for', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: null })]);

    await client.get('/pos/products');

    expect(nth(calls, 0).init.signal).toBeUndefined();
  });
});

describe('timeouts', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  async function timedOut(discardsReason: boolean): Promise<ApiError> {
    jest.useFakeTimers();
    const { impl } = hangingFetch(discardsReason);
    const client = createApiClient({ baseUrl: BASE, tokens: tokenFake(), fetchImpl: impl });

    const pending = client.get('/reports/sales-summary', { timeoutMs: 5_000 });
    // Attached before the clock moves. `failureOf` runs to its first `await`
    // synchronously, so the rejection has a handler by the time the timer fires;
    // ordering this the other way round leaves jest to report an unhandled
    // rejection and fails the test whatever the client did.
    const captured = failureOf(pending);
    await jest.advanceTimersByTimeAsync(5_000);
    return captured;
  }

  it('reports a deadline as a timeout, on a browser that keeps the abort reason', async () => {
    const error = await timedOut(false);

    expect(error.kind).toBe('timeout');
    expect(error.code).toBe('timeout');
    expect(error.status).toBeNull();
    expect(error.message).toBe('The API did not answer within 5000ms');
  });

  it('reports the same deadline as a timeout on a browser that discards the reason', async () => {
    // Without this the older browser reports a cancellation, which a page
    // swallows silently — the counter would watch a hung request and see nothing.
    const error = await timedOut(true);

    expect(error.kind).toBe('timeout');
    expect(error.code).toBe('timeout');
  });

  it('does not call a timeout offline, because the server may have answered it', async () => {
    const error = await timedOut(false);

    // The distinction the queue is built on: a request that never connected
    // certainly did not reach the server, so replaying it is safe. A timed-out
    // sale may have been committed, and replaying it rings up a second one.
    expect(error.isOffline).toBe(false);
    expect(error.isServerFault).toBe(false);
    expect(error.isAuthentication).toBe(false);
  });

  it('does not time out before the deadline', async () => {
    jest.useFakeTimers();
    const { impl, calls } = hangingFetch(false);
    const client = createApiClient({ baseUrl: BASE, tokens: tokenFake(), fetchImpl: impl });

    let settled = false;
    const pending = client.get('/reports/sales-summary', { timeoutMs: 5_000 }).catch(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(4_999);

    expect(settled).toBe(false);
    expect(nth(calls, 0).init.signal?.aborted).toBe(false);

    // Then let it fire, both to prove the deadline is the last millisecond and
    // because awaiting a request that by design never settles would hang the
    // test until jest killed it.
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('gives the replay after a refresh a deadline of its own', async () => {
    const { client, calls } = clientFor(
      [
        jsonResponse(401, { success: false, error: { message: 'Session expired', code: 'token_invalid' } }),
        jsonResponse(200, { success: true, data: null }),
      ],
      tokenFake('access-1', [true])
    );

    await client.get('/pos/sales', { timeoutMs: 5_000 });

    // A deadline set once for the whole request would leave the replay with
    // whatever the first attempt did not use — or with a signal that had already
    // fired, so the retry failed before it was sent.
    expect(calls).toHaveLength(2);
    expect(nth(calls, 1).init.signal).toBeDefined();
    expect(nth(calls, 1).init.signal).not.toBe(nth(calls, 0).init.signal);
  });

  it('clears the timer once the attempt settles, so polling does not accumulate them', async () => {
    jest.useFakeTimers();
    const { client } = clientFor([jsonResponse(200, { success: true, data: null })]);

    await client.get('/pos/sales', { timeoutMs: 5_000 });

    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the timer after a failure too', async () => {
    jest.useFakeTimers();
    const { client } = clientFor([
      jsonResponse(500, { success: false, error: { message: 'Something went wrong' } }),
    ]);

    await failureOf(client.get('/pos/sales', { timeoutMs: 5_000 }));

    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('requests outside the session', () => {
  it('sends no bearer token when told the request is not part of the session', async () => {
    const { client, calls } = clientFor([
      jsonResponse(200, { success: true, data: { accessToken: 'new-access' } }),
    ]);

    await client.post(
      '/auth/login',
      { email: 'ama@aandb.example', password: 'correct horse' },
      { withSession: false }
    );

    // A login wearing the previous person's stale token is how a shared counter
    // tablet ends up attributing one cashier's sign-in to another.
    expect('authorization' in headersOf(nth(calls, 0))).toBe(false);
  });

  it('does not refresh or sign out on a 401 it was told not to retry', async () => {
    const { client, calls, tokens } = clientFor(
      [
        jsonResponse(401, {
          success: false,
          error: { message: 'This session has ended. Sign in again.', code: 'invalid_token' },
        }),
      ],
      tokenFake('stale-access', [true])
    );

    const error = await failureOf(
      client.post('/auth/refresh', { refreshToken: 'r-1' }, { withSession: false })
    );

    // The hang this prevents: a 401 on `/auth/refresh` answered by calling
    // `TokenSource.refresh()` is that same request asking itself to complete.
    // The coalescing would hand it its own unresolved promise and sign-in would
    // never settle — indistinguishable, at the counter, from a dead tablet.
    expect(calls).toHaveLength(1);
    expect(tokens.refreshCalls).toBe(0);
    expect(tokens.unauthenticatedCalls).toBe(0);
    expect(error.status).toBe(401);
    // The message still reaches the sign-in form, which is the whole point of
    // not swallowing it.
    expect(error.message).toBe('This session has ended. Sign in again.');
  });

  it('carries the session unless told otherwise', async () => {
    const { client, calls } = clientFor([jsonResponse(200, { success: true, data: null })]);

    await client.get('/auth/me');

    // Opt-out rather than opt-in: a page that forgets the flag should get the
    // ordinary authenticated behaviour, not a silent 401.
    expect(headersOf(nth(calls, 0)).authorization).toBe('Bearer access-1');
  });
});
