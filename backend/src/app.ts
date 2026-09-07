import compression from 'compression';
import cors from 'cors';
import express, { type Express, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/error';
import { mountRoutes } from './routes';
import { PAYSTACK_WEBHOOK_PATH } from './services/paystack.service';
import { HttpError, sendError } from './utils/http';

/**
 * Builds the Express app without listening on a port.
 *
 * A factory rather than a module-level `app`, so a test can build one, drive it
 * with supertest and tear it down without ever claiming the configured port.
 * supertest binds an ephemeral port per request; a suite that listened on 5000
 * would collide with every other suite jest runs alongside it.
 *
 * Middleware order below is load-bearing. Moving a line changes behaviour:
 * `trust proxy` before the rate limiter, body parsers before the routes that
 * read bodies, and the 404 and error handlers last.
 */
export function createApp(): Express {
  const app = express();

  // Set before anything reads `req.ip`. Render terminates TLS and forwards, so
  // without this every request appears to come from the proxy and the whole
  // pharmacy shares one rate-limit bucket — one stuck tab locks out the till.
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  app.use(
    helmet({
      // The API serves JSON, never HTML, so a content-security policy here would
      // only add headers to responses that cannot execute anything. It is left
      // on default for the headers that do matter, notably no-sniff.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header means curl, a server-to-server call or the platform
        // health check. Rejecting those would break the health check, and CORS
        // is a browser-enforced control anyway — it never stopped an attacker.
        if (origin === undefined || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new HttpError(403, `Origin ${origin} is not permitted`, { code: 'origin_not_allowed' }));
      },
      credentials: true,
    })
  );

  // A sale receipt is small but a stock list is not, and Render's free tier
  // bills nothing for bandwidth it does not have to send twice.
  app.use(compression());

  app.use(
    morgan(config.isProduction ? 'combined' : 'dev', {
      skip: () => config.isTest,
    })
  );

  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        // The webhook's HMAC is computed over the exact bytes Paystack sent, and
        // by the time a route handler runs those bytes are gone: `express.json`
        // consumes the stream and leaves a parsed object behind. Re-serialising
        // it with `JSON.stringify` will not reproduce them — key order survives a
        // parse and a stringify only by luck, whitespace never does, and a body
        // with a non-ASCII character round-trips differently. A signature check
        // written that way fails on some small fraction of real payloads, which
        // is indistinguishable from an attack and gets "fixed" by disabling it.
        // So the buffer is kept here, at the one moment it still exists.
        //
        // Kept for the webhook path only. Every other request would otherwise
        // carry a second copy of its body for the lifetime of the request, and
        // the CSV import is allowed to be eight megabytes of it.
        if (req.url !== undefined && req.url.startsWith(PAYSTACK_WEBHOOK_PATH)) {
          (req as Request).rawBody = buf;
        }
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  // The CSV stock import arrives as text, not JSON. Parsed here rather than
  // hand-rolled in the route so a malformed row is a data problem and a truncated
  // upload is a body-parser problem, and the two are distinguishable.
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '8mb' }));

  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) =>
        // Paystack retries a webhook that answers 429, and eventually stops.
        // A dropped confirmation is a paid sale left pending forever. The
        // webhook is authenticated by its HMAC signature instead of by volume.
        req.path.startsWith(PAYSTACK_WEBHOOK_PATH),
      handler: (_req, res) =>
        sendError(res, 429, 'Too many requests. Wait a moment and try again.', {
          code: 'rate_limited',
        }),
    })
  );

  // The complete route table lives in routes/index.ts, so that "which endpoints
  // exist" and "which of them answer without a token" are one file to read
  // rather than two to reconcile.
  mountRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
