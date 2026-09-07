import { createApp } from './app';
import { config } from './config';
import { closePool } from './database/pool';
import { scoped } from './utils/logger';

/**
 * Process entry point. Nothing else imports this file, which is why it is safe
 * for it to start listening on import.
 */

const log = scoped('server');

/**
 * How long to wait for in-flight requests during shutdown before leaving
 * anyway. Render sends SIGTERM and does not wait indefinitely; a client holding
 * a keep-alive connection open would otherwise keep the old process serving
 * stale code through a deploy.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  const app = createApp();

  const server = app.listen(config.port, () => {
    log.info(`API listening on port ${config.port}`, {
      environment: config.nodeEnv,
      gateway: config.paystack.configured ? config.paystack.mode : 'unconfigured',
    });

    if (!config.paystack.configured) {
      // Announced at boot rather than discovered at the counter. With no keys the
      // till records a mobile money payment as a manual entry, and the person
      // who needs to know that is whoever is deploying, not the customer waiting
      // to be served.
      log.warn(
        'Paystack is not configured — mobile money will be recorded manually, not charged'
      );
    }
  });

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    // Guarded because SIGTERM and SIGINT can both arrive, and a second pass
    // would close an already-closing server and exit while the first pass is
    // still draining requests.
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, draining connections`);

    const deadline = setTimeout(() => {
      log.error('shutdown deadline reached with connections still open, exiting');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    // Unref'd so the timer alone never keeps the process alive after everything
    // else has finished.
    deadline.unref();

    server.close(() => {
      void closePool()
        .catch((error: unknown) => {
          log.error('error while closing the database pool', { error: describe(error) });
        })
        .finally(() => {
          clearTimeout(deadline);
          process.exit(0);
        });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An uncaught exception leaves the process in a state nobody can reason about,
  // and this one holds open database transactions. Restarting is safer than
  // continuing: Render brings the instance back in seconds, and an in-flight
  // sale is rolled back by Postgres rather than half-committed.
  process.on('uncaughtException', (error: Error) => {
    log.error('uncaught exception, exiting', { error: error.message, stack: error.stack });
    process.exit(1);
  });

  // An unhandled rejection is logged and the process stays up. Every route goes
  // through `asyncHandler`, so a rejection reaching here came from background
  // work whose request was already answered; killing the process would take down
  // a till that is serving customers to punish a bug that has already finished
  // doing its damage. It is logged loudly so it gets fixed.
  process.on('unhandledRejection', (reason: unknown) => {
    log.error('unhandled promise rejection', {
      error: describe(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

main();
