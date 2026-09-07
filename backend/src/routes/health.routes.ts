import { Router } from 'express';
import { config } from '../config';
import { probeDatabase } from '../database/pool';
import { asyncHandler } from '../utils/async-handler';
import { sendError, sendOk } from '../utils/http';

/**
 * Liveness, readiness and the pre-sign-in config probe, and nothing else.
 *
 * All three are unauthenticated by design — a health check that needs a token
 * cannot be called by the platform that is deciding whether to route traffic
 * here. Nothing here reveals more than "this process is up", "the database
 * answered" and "is the gateway configured".
 */
export const healthRoutes = Router();

/**
 * Liveness. Touches no dependency, so it keeps answering while the database is
 * down. Render's `healthCheckPath` points here: a liveness probe that fails
 * because of an outage elsewhere causes a restart loop, which makes the outage
 * worse rather than better.
 */
healthRoutes.get('/', (_req, res) => {
  sendOk(res, {
    status: 'ok',
    service: 'a-and-b-chemist-api',
    environment: config.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/**
 * Readiness. Answers 503 when the database does not, within a deadline, so a
 * hung database is reported as unhealthy instead of making every caller wait out
 * the full connection timeout.
 */
healthRoutes.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const probe = await probeDatabase();
    if (!probe.ok) {
      sendError(res, 503, 'Database is not reachable', {
        code: 'database_unavailable',
        // The driver's message names hosts and roles. Useful on a laptop, not
        // something to publish from a production instance.
        ...(config.isProduction ? {} : { details: probe.error }),
      });
      return;
    }
    sendOk(res, { status: 'ready', databaseLatencyMs: probe.latencyMs });
  })
);

/**
 * What the frontend needs to know before it can sign in.
 *
 * Public, and deliberately tiny. The till reads this on load to decide whether
 * to offer the mobile-money prompt or the honest manual fallback, and it cannot
 * do that from behind a token it does not have yet.
 *
 * No key material of any kind: the secret key never leaves this process, and
 * the public key comes from the authenticated payment-config route in the POS
 * phase, where the caller has proved who they are. No rate-limit thresholds
 * either — publishing "ten per quarter hour" tells an attacker exactly how to
 * pace themselves under it, which converts a defence into a schedule.
 */
healthRoutes.get('/config', (_req, res) => {
  sendOk(res, {
    environment: config.nodeEnv,
    paystack: {
      configured: config.paystack.configured,
      // `test` and `live` are safe to state and worth stating: a till running
      // against test keys must not look identical to one taking real money.
      mode: config.paystack.mode,
    },
  });
});
