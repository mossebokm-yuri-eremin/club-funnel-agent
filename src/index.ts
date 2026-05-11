import { config } from './config.js';
import { log } from './observability/logger.js';
import { pool, closePool } from './db/client.js';
import { redis, closeRedis } from './redis.js';

async function main(): Promise<void> {
  log.info(
    {
      env: config.NODE_ENV,
      app: config.APP_NAME,
      port: config.APP_PORT,
      public_url: config.APP_PUBLIC_BASE_URL,
      tz: config.TZ,
    },
    'club-funnel-agent: starting',
  );

  try {
    const pg = await pool.query<{ now: string }>('SELECT NOW() as now');
    log.info({ pg_now: pg.rows[0]?.now }, 'pg: connection ok');
  } catch (err) {
    log.warn({ err }, 'pg: connection failed (continuing for bootstrap)');
  }

  try {
    const pong = await redis.ping();
    log.info({ pong }, 'redis: ping ok');
  } catch (err) {
    log.warn({ err }, 'redis: ping failed (continuing for bootstrap)');
  }

  log.info(
    'bootstrap complete. Subsystems (bot/webhooks/jobs) will be wired up in subsequent phases.',
  );
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  log.info({ signal }, 'shutdown: received signal, closing resources');
  try {
    await closeRedis();
  } catch (err) {
    log.error({ err }, 'shutdown: redis close failed');
  }
  try {
    await closePool();
  } catch (err) {
    log.error({ err }, 'shutdown: pg close failed');
  }
  process.exit(0);
}

process.on('SIGINT', (s) => {
  void shutdown(s);
});
process.on('SIGTERM', (s) => {
  void shutdown(s);
});

process.on('unhandledRejection', (reason) => {
  log.fatal({ reason }, 'unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

void main().catch((err: unknown) => {
  log.fatal({ err }, 'fatal: main() crashed');
  process.exit(1);
});
