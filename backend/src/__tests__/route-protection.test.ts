jest.mock('../database/pool', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn(),
  probeDatabase: jest.fn().mockResolvedValue({ ok: false, error: 'unused in this suite' }),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { PUBLIC_ROUTE_PREFIXES } from '../routes';

/**
 * No route answers without a token unless it is on the public list.
 *
 * This is the acceptance criterion, and it is proved by walking the real router
 * rather than by repeating a hand-written list of endpoints.
 *
 * ## What the 401 walk does and does not prove
 *
 * It proves that no route answers data to a caller with no token. It does **not**
 * prove that `authenticate` is mounted, and believing otherwise would be a false
 * comfort: `authorize` answers 401 when `req.auth` is missing, and `requireAuth`
 * does the same inside a handler, so a mount that lost `authenticate` but kept
 * its per-route `authorize` still answers 401 to every request and this suite
 * stays green. Three layers each independently refuse, and the walk asserts the
 * status rather than the chain, so it cannot tell which one refused.
 *
 * That is the right trade. The guarantee a caller cares about is the status, and
 * asserting the middleware chain instead would pin an implementation and fail on
 * a refactor that kept the protection. What catches a missing `authenticate` is
 * not this walk but the fact that the route then has no `req.auth` to read — the
 * 401 is the protection working from the layer below.
 *
 * The route table assertion is the part with teeth on additions: a new endpoint
 * is a reviewed change to `EXPECTED_ROUTES` rather than something that appears
 * silently, and a new public prefix has to be added to the pinned list by hand.
 *
 * It reads Express's private `app._router.stack`. That is a deliberate
 * dependency on an internal, and it is guarded below: if a future Express
 * removes it, `routerStack` throws with an instruction rather than letting the
 * suite pass vacuously against an empty list. A protection test that can
 * silently stop testing is worse than no protection test.
 */

interface RouteLayer {
  name: string;
  regexp: RegExp;
  route?: { path: string; methods: Record<string, boolean>; stack: RouteLayer[] };
  handle?: { stack?: RouteLayer[] };
}

interface CollectedRoute {
  path: string;
  methods: string[];
}

/**
 * The route table the platform is expected to produce, as `METHOD /path`.
 *
 * In the order `Array.prototype.sort()` puts it, which is UTF-16 code-unit order
 * over the whole string and not a human's alphabetical idea of it. Two consequences
 * worth knowing before editing this list, because both look wrong and are right:
 *
 * Methods sort first, so every `GET` precedes every `PATCH`, which precedes every
 * `POST`, which precedes `PUT` — `G` < `P`, then `A` < `O`, then `O` < `U`.
 *
 * Within a method, `:` (0x3A) sorts before every letter, so `GET /inventory/:id`
 * comes before `GET /inventory/alerts` and `POST /notifications/:id/read` before
 * `POST /notifications/read-all`. A list re-sorted by eye into something that reads
 * better fails this suite, and the failure looks like a missing route.
 */
const EXPECTED_ROUTES = [
  'GET /auth/me',
  'GET /consultations',
  'GET /consultations/:id',
  'GET /health',
  'GET /health/config',
  'GET /health/ready',
  'GET /inventory',
  'GET /inventory/:id',
  'GET /inventory/:id/batches',
  'GET /inventory/:id/batches/:batchId/recall',
  'GET /inventory/:id/movements',
  'GET /inventory/alerts',
  'GET /inventory/import/template',
  'GET /notifications',
  'GET /notifications/reminders',
  'GET /patients',
  'GET /patients/:id',
  'GET /prescriptions',
  'GET /prescriptions/:id',
  'GET /reports/sales',
  'GET /sales',
  'GET /sales/:id',
  'GET /sales/approvers',
  'GET /sales/categories',
  'GET /sales/payment-config',
  'GET /sales/products',
  'GET /screenings',
  'GET /screenings/latest',
  'GET /staff',
  'GET /tax/settings',
  'PATCH /consultations/:id',
  'PATCH /inventory/:id',
  'PATCH /patients/:id',
  'PATCH /prescriptions/:id',
  'PATCH /staff/:id',
  'POST /auth/login',
  'POST /auth/logout',
  'POST /auth/refresh',
  'POST /consultations',
  'POST /consultations/:id/end',
  'POST /inventory',
  'POST /inventory/:id/batches',
  'POST /inventory/:id/batches/:batchId/adjust',
  'POST /inventory/:id/batches/:batchId/write-off',
  'POST /inventory/alerts/scan',
  'POST /inventory/import',
  'POST /notifications/:id/read',
  'POST /notifications/read-all',
  'POST /notifications/refresh',
  'POST /patients',
  'POST /prescriptions',
  'POST /prescriptions/:id/approve',
  'POST /prescriptions/:id/dispense',
  'POST /prescriptions/:id/reject',
  'POST /sales',
  'POST /sales/:id/payments',
  'POST /sales/:id/void',
  'POST /sales/payments/:paymentId/verify',
  'POST /sales/quote',
  'POST /screenings',
  'POST /staff',
  'POST /staff/:id/reset-password',
  'POST /webhooks/paystack',
  'PUT /tax/settings',
];

const SAMPLE_UUID = 'a0000000-0000-4000-8000-000000000001';

/**
 * One app for the suite. The rate limiters live as long as the module, so a
 * second `createApp()` would carry two independent limiters and a test that
 * exhausted one would not affect the other — which is only confusing when a
 * later phase adds a limited route to the protected list.
 */
const app = createApp();

function routerStack(instance: Express): RouteLayer[] {
  const router = (instance as unknown as { _router?: { stack?: RouteLayer[] } })._router;
  if (router === undefined || !Array.isArray(router.stack)) {
    throw new Error(
      'Express no longer exposes app._router.stack. This suite walks the real router to prove that ' +
        'no route answers without a token; update the walk to the new internal shape rather than ' +
        'deleting it, or the guarantee quietly becomes nothing.'
    );
  }
  return router.stack;
}

/**
 * The mount prefix a layer matches.
 *
 * Express marks a pathless `use()` with `regexp.fast_slash` rather than giving
 * it a decodable pattern, so that case is read directly. Otherwise the source
 * of `/^\/staff\/?(?=\/|$)/i` is unescaped and the trailing lookahead removed.
 */
function prefixOf(layer: RouteLayer): string {
  const regexp = layer.regexp as RegExp & { fast_slash?: boolean; fast_star?: boolean };
  if (regexp.fast_slash === true || regexp.fast_star === true) return '';

  return regexp.source
    .replace(/^\^/, '')
    .replace(/\\\//g, '/')
    .replace(/\/\?\(\?=\/\|\$\)$/, '')
    .replace(/\$$/, '');
}

function joinPath(prefix: string, segment: string): string {
  const full = `${prefix}${segment === '/' ? '' : segment}`;
  return full === '' ? '/' : full;
}

function collectRoutes(instance: Express): CollectedRoute[] {
  const collected: CollectedRoute[] = [];

  const walk = (layers: RouteLayer[], prefix: string): void => {
    for (const layer of layers) {
      if (layer.route !== undefined) {
        const methods = Object.keys(layer.route.methods).filter(
          (method) => layer.route?.methods[method] === true
        );
        collected.push({ path: joinPath(prefix, layer.route.path), methods });
        continue;
      }
      // A mounted sub-router is recognised by its handler holding a stack of its
      // own. `Array.isArray` rather than `layer.name === 'router'`, because a
      // name is a function's own business and a stack is the thing being walked.
      if (Array.isArray(layer.handle?.stack)) {
        walk(layer.handle.stack as RouteLayer[], joinPath(prefix, prefixOf(layer)));
      }
      // Everything else is middleware — helmet, cors, the rate limiters,
      // authenticate itself — and has no routes to collect.
    }
  };

  walk(routerStack(instance), '');
  return collected.sort((left, right) => left.path.localeCompare(right.path));
}

function isPublic(path: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

/** Replaces `:param` segments with something that satisfies a UUID validator. */
function concreteUrl(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, SAMPLE_UUID);
}

function send(method: string, path: string): request.Test {
  const agent = request(app) as unknown as Record<string, (url: string) => request.Test>;
  const verb = agent[method.toLowerCase()];
  if (verb === undefined) {
    throw new Error(`no supertest verb for ${method.toUpperCase()}`);
  }
  return verb.call(agent, path);
}

describe('route protection', () => {
  const routes = collectRoutes(app);

  it('found the route table, so the walk is not passing against nothing', () => {
    // Guard against the vacuous pass. If the internals change shape and the walk
    // collects two routes instead of eleven, the assertions below would all hold
    // and mean nothing.
    expect(routes.length).toBeGreaterThanOrEqual(EXPECTED_ROUTES.length);
  });

  it('exposes exactly the routes the platform builds', () => {
    const actual = routes.flatMap((route) =>
      route.methods.map((method) => `${method.toUpperCase()} ${route.path}`)
    );

    // Pinned as an exact list so that adding an endpoint is a reviewed change to
    // this file rather than something that appears silently. The diff on failure
    // shows what was actually collected, which doubles as a route inventory.
    expect(actual.sort()).toEqual(EXPECTED_ROUTES);
  });

  it('declares no public prefix that has no routes under it', () => {
    for (const prefix of PUBLIC_ROUTE_PREFIXES) {
      const matching = routes.filter((route) => route.path === prefix || route.path.startsWith(`${prefix}/`));
      expect(matching.length).toBeGreaterThan(0);
    }
  });

  it('answers 401 to every protected route, for every verb, with no token', async () => {
    const violations: string[] = [];

    for (const route of routes) {
      if (isPublic(route.path)) continue;
      for (const method of route.methods) {
        const response = await send(method, concreteUrl(route.path));
        // Exactly 401. A 200 is the failure this suite exists for; a 404 would
        // mean the walk and the router disagree about what is mounted; a 403
        // would mean authorisation ran without authentication having set the
        // context, which is a mounting mistake wearing a plausible status.
        if (response.status !== 401) {
          violations.push(`${method.toUpperCase()} ${route.path} answered ${response.status}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('answers every public route without a token', async () => {
    const blocked: string[] = [];

    for (const route of routes) {
      if (!isPublic(route.path)) continue;
      for (const method of route.methods) {
        const response = await send(method, concreteUrl(route.path));
        // Not 401. The status itself varies — 200 for the health probes, 503
        // when the mocked database refuses, 400 when a login body is missing its
        // fields — and all of those mean the request reached the route.
        if (response.status === 401) {
          blocked.push(`${method.toUpperCase()} ${route.path} demanded a token`);
        }
      }
    }

    // A public prefix that secretly required a token would break the health
    // check the platform depends on and the sign-in that issues tokens in the
    // first place — an unrecoverable lockout, not a minor misconfiguration.
    expect(blocked).toEqual([]);
  });

  it('keeps the public list to the four prefixes that must be public', () => {
    // The fourth is the Paystack webhook, which is unauthenticated at the HTTP
    // level and authenticated by its HMAC signature instead. It is on this list
    // because it has to answer to a gateway that has no staff token — and it is
    // on this list *loudly*, because a public prefix is the one entry here that
    // widens the attack surface rather than narrowing it.
    expect([...PUBLIC_ROUTE_PREFIXES].sort()).toEqual([
      '/auth/login',
      '/auth/refresh',
      '/health',
      '/webhooks/paystack',
    ]);
  });
});
