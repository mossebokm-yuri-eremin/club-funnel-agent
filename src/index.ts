import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { log } from './observability/logger.js';
import { pool, closePool } from './db/client.js';
import { redis, closeRedis } from './redis.js';
import { getCourseWebhookPlugin } from './webhooks/getcourse.js';
import { bootstrapBot } from './bot/index.js';
import { closeAllQueues, getCoursePullQueue } from './jobs/queues.js';
import { createSttWorker } from './jobs/stt-worker.js';
import { createReferenceDetectWorker } from './jobs/reference-detect-worker.js';
import { createReferenceProcessWorker } from './jobs/reference-process-worker.js';
import { createIdeaWorker } from './jobs/idea-worker.js';
import { createContentWorker } from './jobs/content-worker.js';
import { createCarouselWorker } from './jobs/carousel-worker.js';
import { createFunnelWorker } from './jobs/funnel-worker.js';
import { createGetCoursePullWorker } from './jobs/getcourse-pull-worker.js';
import {
  createGetCourseParserWorker,
  scheduleGetCourseParserCron,
} from './jobs/getcourse-parser-worker.js';
import {
  createWarmupSenderWorker,
  scheduleWarmupSenderCron,
} from './jobs/warmup-sender-worker.js';
import {
  createBillingAlertWorker,
  scheduleBillingAlertCron,
} from './jobs/billing-alert-worker.js';
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

  // Diagnostic: тест прокси и Nano Banana. Auth — Bearer token из TEST_ENDPOINT_TOKEN.
  // Возвращает first-100-bytes от ответа Gemini, чтобы понять что приходит.
  // Diagnostic: тест GPTunnel Creative (seedream-4 / 8₽). Bearer = TEST_ENDPOINT_TOKEN.
  // POST body: { prompt: string, aspectRatio?: '9:16'|'1:1'|... , size?: '1K'|'2K' }
  app.post('/test/gptunnel-image', async (req, reply) => {
    const token = config.TEST_ENDPOINT_TOKEN;
    const auth = (req.headers['authorization'] ?? '') as string;
    if (!token || auth !== `Bearer ${token}`) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    try {
      const { generateGptunnelImage } = await import('./integrations/gptunnel-creative.js');
      const body = (req.body ?? {}) as {
        prompt?: string;
        aspectRatio?: string;
        size?: string;
      };
      const result = await generateGptunnelImage({
        prompt:
          body.prompt ??
          'Premium minimalist editorial photography. Soft warm light. Clean composition. No text. No logos.',
        aspectRatio: (body.aspectRatio as '9:16' | '1:1' | '4:3' | '3:4' | undefined) ?? '9:16',
        size: (body.size as '1K' | '2K' | '3K' | '4K' | undefined) ?? '2K',
      });
      return {
        ok: true,
        imageUrl: result.imageUrl,
        costRub: result.costRub,
        costKopecks: result.costKopecks,
        generationId: result.generationId,
        modelUsed: result.modelUsed,
        durationMs: result.durationMs,
      };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: (err as Error).message };
    }
  });

  // /test/carousel-with-style — рендерит карусель целиком (style-transfer flow):
  // classify theme → select GDrive references → Seedream per-slide → Sharp overlay → upload.
  // body: { content_package_id: uuid }
  app.post('/test/carousel-with-style', async (req, reply) => {
    const token = config.TEST_ENDPOINT_TOKEN;
    const auth = (req.headers['authorization'] ?? '') as string;
    if (!token || auth !== `Bearer ${token}`) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const body = (req.body ?? {}) as { content_package_id?: string };
    if (!body.content_package_id) {
      reply.code(400);
      return { ok: false, error: 'content_package_id required' };
    }
    try {
      const { renderCarousel } = await import('./services/carousel-renderer.js');
      const res = await renderCarousel(
        { contentPackageId: body.content_package_id },
        { pool },
      );
      return {
        ok: true,
        contentPackageId: res.contentPackageId,
        theme: res.theme,
        templateFolder: res.templateFolderName,
        classifiedBy: res.classifiedBy,
        slides: res.slides.map((s) => ({
          index: s.index,
          url: s.url,
          source: s.source,
          bytes: s.bytes,
          durationMs: s.durationMs,
        })),
        totalDurationMs: res.totalDurationMs,
      };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post('/test/image-gen', async (req, reply) => {
    const token = config.TEST_ENDPOINT_TOKEN;
    const auth = (req.headers['authorization'] ?? '') as string;
    if (!token || auth !== `Bearer ${token}`) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    try {
      const { generateImage } = await import('./integrations/nano-banana.js');
      const { isGeminiProxyEnabled } = await import('./integrations/gemini-fetch.js');
      const startedAt = Date.now();
      const result = await generateImage({
        prompt: 'A simple flat illustration of a notebook with a pen, soft pastel colors.',
        aspectRatio: '4:5',
      });
      return {
        ok: true,
        proxyEnabled: isGeminiProxyEnabled(),
        mimeType: result.mimeType,
        bytes: result.png.length,
        promptTokenCount: result.promptTokenCount ?? null,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      reply.code(502);
      return {
        ok: false,
        error: (err as Error).message,
      };
    }
  });

  // ── Public longread render: GET /longread/:bonusId
  //   Отдаёт HTML с body_md из bonus_library (markdown → html через простой парсер).
  //   Защиты от приватных лонгридов нет — каждый кто знает bonus_id может прочитать.
  app.get<{ Params: { bonusId: string } }>('/longread/:bonusId', async (req, reply) => {
    const id = req.params.bonusId;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      reply.code(400);
      return { error: 'invalid bonus id' };
    }
    const r = await pool.query<{ title: string; body_md: string; cover_image_url: string | null }>(
      `SELECT title, body_md, cover_image_url FROM bonus_library WHERE id = $1 AND status = 'live' AND deleted_at IS NULL`,
      [id],
    );
    const row = r.rows[0];
    if (!row) {
      reply.code(404);
      return { error: 'longread not found' };
    }
    // Простой markdown → html (только заголовки, абзацы, **жир**, *курсив*).
    const html = row.body_md
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .split(/\n{2,}/)
      .map((p) => (p.match(/^<h\d>/) ? p : `<p>${p.trim()}</p>`))
      .join('\n');
    const safeTitle = row.title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
    const cover = row.cover_image_url ? `<img src="${row.cover_image_url}" style="max-width:100%;border-radius:12px;margin-bottom:32px">` : '';
    const fullHtml = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>${safeTitle} — Юрий Еремин</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Inter',-apple-system,sans-serif; max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; color: #181818; background: #faf8f3; line-height: 1.6; font-size: 18px; }
  h1 { font-size: 40px; line-height: 1.15; margin: 0 0 24px; color: #0f0f0f; }
  h2 { font-size: 28px; margin: 40px 0 16px; color: #0f0f0f; }
  h3 { font-size: 22px; margin: 32px 0 12px; }
  p { margin: 0 0 18px; }
  strong { font-weight: 700; }
  em { font-style: italic; color: #b04a2f; }
  footer { margin-top: 64px; padding-top: 32px; border-top: 1px solid #d3d0c8; color: #777; font-size: 14px; }
</style></head>
<body>${cover}<h1>${safeTitle}</h1>${html}
<footer>Юрий Еремин · клуб «Реализация»</footer></body></html>`;
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return fullHtml;
  });

  // GetCourse webhook — пишет любой запрос в getcourse_raw_events, всегда 200.
  // Парсинг → getcourse-parser-worker.ts (раз в 10 сек).
  await app.register(getCourseWebhookPlugin, {
    secret: config.GC_WEBHOOK_SECRET,
    pool,
  });

  // Admin: GetCourse debug endpoints. Bearer = TEST_ENDPOINT_TOKEN.
  const requireAdminAuth = (req: { headers: Record<string, unknown> }): boolean => {
    const token = config.TEST_ENDPOINT_TOKEN;
    const auth = (req.headers['authorization'] ?? '') as string;
    return Boolean(token) && auth === `Bearer ${token}`;
  };

  app.get('/admin/getcourse/recent', async (req, reply) => {
    if (!requireAdminAuth(req)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const limitRaw = (req.query as { limit?: string } | undefined)?.limit;
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '20', 10) || 20, 1), 100);
    const r = await pool.query(
      `SELECT id, received_at, request_method, request_path, ip_address, user_agent,
              hmac_valid, content_type, query_params, body_parsed, body_raw,
              parse_status, parse_error, parsed_event_type, parsed_user_email,
              parsed_amount_kopecks, parsed_order_id, notified_at, headers
         FROM getcourse_raw_events
        ORDER BY received_at DESC
        LIMIT $1`,
      [limit],
    );
    return { count: r.rows.length, events: r.rows };
  });

  app.get<{ Params: { id: string } }>('/admin/getcourse/event/:id', async (req, reply) => {
    if (!requireAdminAuth(req)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const r = await pool.query(
      `SELECT * FROM getcourse_raw_events WHERE id = $1`,
      [req.params.id],
    );
    if (r.rows.length === 0) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return r.rows[0];
  });

  // Admin: billing summary (image_generations). Bearer = TEST_ENDPOINT_TOKEN.
  // GET /admin/billing?period=today|week|month
  app.get('/admin/billing', async (req, reply) => {
    if (!requireAdminAuth(req)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const periodRaw = (req.query as { period?: string } | undefined)?.period ?? 'today';
    const period = (['today', 'week', 'month'] as const).includes(periodRaw as 'today')
      ? (periodRaw as 'today' | 'week' | 'month')
      : 'today';
    const { getBillingSummary } = await import('./services/image-billing.js');
    return getBillingSummary(pool, period);
  });

  app.post<{ Params: { id: string } }>('/admin/getcourse/retry/:id', async (req, reply) => {
    if (!requireAdminAuth(req)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const { retryOneEvent } = await import('./jobs/getcourse-parser-worker.js');
    const ok = await retryOneEvent(pool, req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { id: req.params.id, status: 'requeued (parse_status=pending)' };
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
    createReferenceProcessWorker({ pool }),
    createIdeaWorker({ pool }),
    createContentWorker({ pool }),
    createCarouselWorker({ pool }),
    createFunnelWorker({ pool }),
  ];
  if (!config.GC_PULL_DISABLED) {
    workers.push(createGetCoursePullWorker({ pool }));
  } else {
    log.info({}, 'gc-pull: worker disabled via GC_PULL_DISABLED=true');
  }
  // GetCourse raw-events parser (всегда включён — недорогой polling каждые 10s).
  workers.push(createGetCourseParserWorker({ pool }));
  // Warmup sender (cron каждые 5 мин) — отправляет прогревочные сообщения по
  // warmup_messages WHERE status='pending' AND scheduled_at <= NOW().
  workers.push(createWarmupSenderWorker({ pool }));
  // Billing alert (cron каждый час — TG-алерт если суточный расход на
  // image_generations превысит BILLING_DAILY_ALERT_KOPECKS).
  workers.push(createBillingAlertWorker({ pool }));
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
  const bootstrapOpts: Parameters<typeof bootstrapBot>[1] = { pool };
  if (config.TG_WEBHOOK_SECRET) bootstrapOpts.secretToken = config.TG_WEBHOOK_SECRET;
  const bot = await bootstrapBot(app, bootstrapOpts);
  resources.bot = bot;

  // Workers — запускаются всегда (BullMQ переподключается к Redis сам).
  resources.workers = buildBotWorkers(bot);

  // Cron: hourly pull GetCourse subscribers (SPEC §2.11 AC-31).
  try {
    if (config.GC_PULL_DISABLED) {
      log.info({}, 'gc-pull cron: skipped (GC_PULL_DISABLED=true)');
    } else {
      await scheduleGetCoursePullCron();
    }
  } catch (err) {
    log.warn({ err }, 'gc-pull cron: failed to schedule (continuing)');
  }

  // Cron: GetCourse raw-events parser (раз в 10 сек).
  try {
    await scheduleGetCourseParserCron();
  } catch (err) {
    log.warn({ err }, 'gc-parser cron: failed to schedule (continuing)');
  }

  // Cron: warmup sender (каждые 5 мин — AC-28 + AC-30 long chain).
  try {
    await scheduleWarmupSenderCron();
  } catch (err) {
    log.warn({ err }, 'warmup-sender cron: failed to schedule (continuing)');
  }

  // Cron: billing alert (каждый час — TG если суточный расход > порога).
  try {
    await scheduleBillingAlertCron();
  } catch (err) {
    log.warn({ err }, 'billing-alert cron: failed to schedule (continuing)');
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
