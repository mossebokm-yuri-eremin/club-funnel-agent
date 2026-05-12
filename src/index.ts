import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { log } from './observability/logger.js';
import { pool, closePool } from './db/client.js';
import { redis, closeRedis } from './redis.js';
import { getCourseWebhookPlugin, redisIdempotencyStore, type RedisLike } from './webhooks/getcourse.js';
import { bootstrapBot } from './bot/index.js';
import { closeAllQueues, getCoursePullQueue } from './jobs/queues.js';
import { createSttWorker } from './jobs/stt-worker.js';
import { createReferenceDetectWorker } from './jobs/reference-detect-worker.js';
import { createIdeaWorker } from './jobs/idea-worker.js';
import { createContentWorker } from './jobs/content-worker.js';
import { createCarouselWorker } from './jobs/carousel-worker.js';
import { createFunnelWorker } from './jobs/funnel-worker.js';
import { createGetCoursePullWorker } from './jobs/getcourse-pull-worker.js';
import type { Bot } from 'grammy';

interface Shutdownable {
  close: () => Promise<unknown>;
}

const resources: { app?: FastifyInstance; bot?: Bot; workers: Shutdownable[] } = {
  workers: [],
};

async function buildHttpServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // pino логируется отдельно
    bodyLimit: 2 * 1024 * 1024,
  });

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // GetCourse webhook (HMAC) — регистрируем первым: он ставит rawBody parser.
  await app.register(getCourseWebhookPlugin, {
    secret: config.GC_WEBHOOK_SECRET,
    // ioredis Redis имеет ovrloads SET, которые TS не сводит к RedisLike напрямую.
    idempotency: redisIdempotencyStore(redis as unknown as RedisLike),
  });

  return app;
}

function buildBotWorkers(bot: Bot): Shutdownable[] {
  const resolveTgFileUrl = async (fileId: string): Promise<string> => {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error(`telegram getFile: no file_path for ${fileId}`);
    return `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  };

  // Возвращаем как Shutdownable[] — массив гомогенен по close-сигнатуре, но
  // объединение Worker<*,*> для 6 разных DataT даёт комбинаторный взрыв в tsc.
  const workers: Shutdownable[] = [
    createSttWorker({ pool, resolveTgFileUrl }),
    createReferenceDetectWorker({ pool }),
    createIdeaWorker({ pool }),
    createContentWorker({ pool }),
    createCarouselWorker({ pool }),
    createFunnelWorker({ pool }),
    createGetCoursePullWorker({ pool }),
  ];
  return workers;
}

/** Ставит cron-задачу для GetCourse hourly pull (SPEC §2.11 AC-31).
 *  Идемпотентно: BullMQ дедуплицирует repeatable job по паттерну. */
async function scheduleGetCoursePullCron(): Promise<void> {
  await getCoursePullQueue().add(
    'subscribers',
    { kind: 'subscribers' },
    {
      repeat: { pattern: config.CRON_GC_RECONCILE },
      jobId: 'gc-pull-cron-subscribers',
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  );
  log.info({ pattern: config.CRON_GC_RECONCILE }, 'gc-pull: cron scheduled');
}

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

  // Smoke-проверки внешних сервисов — не блокируют bootstrap.
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

  const app = await buildHttpServer();
  resources.app = app;

  // Bot — поднимаем после Fastify (плагин монтируется на app).
  const bootstrapOpts: Parameters<typeof bootstrapBot>[1] = {};
  if (config.TG_WEBHOOK_SECRET) bootstrapOpts.secretToken = config.TG_WEBHOOK_SECRET;
  const bot = await bootstrapBot(app, bootstrapOpts);
  resources.bot = bot;

  // Workers — запускаются всегда (BullMQ переподключается к Redis сам).
  resources.workers = buildBotWorkers(bot);

  // Cron: hourly pull GetCourse subscribers (SPEC §2.11 AC-31).
  try {
    await scheduleGetCoursePullCron();
  } catch (err) {
    log.warn({ err }, 'gc-pull cron: failed to schedule (continuing)');
  }

  await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
  log.info({ host: config.APP_HOST, port: config.APP_PORT }, 'http: listening');
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  log.info({ signal }, 'shutdown: received signal, closing resources');
  try {
    await Promise.allSettled(resources.workers.map((w) => w.close()));
  } catch (err) {
    log.error({ err }, 'shutdown: workers close failed');
  }
  try {
    if (resources.app) await resources.app.close();
  } catch (err) {
    log.error({ err }, 'shutdown: fastify close failed');
  }
  try {
    await closeAllQueues();
  } catch (err) {
    log.error({ err }, 'shutdown: queues close failed');
  }
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
