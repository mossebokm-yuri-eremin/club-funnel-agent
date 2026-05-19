// billing-alert-worker — раз в час (BullMQ repeatable) проверяет суточный
// расход на image_generations. Если > BILLING_DAILY_ALERT_KOPECKS — TG-алерт.
//
// Дедупликация: храним метку «последний алерт за этот суточный период» в Redis —
// чтобы не флудить каждый час одним и тем же алертом, пока расход не сбросится
// (естественно за следующие 24h).

import type { Pool } from 'pg';
import { Worker, type Job } from 'bullmq';
import { createRedisClient, redis } from '../redis.js';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES, billingAlertQueue } from './queues.js';
import { dailyCostKopecks, getBillingSummary } from '../services/image-billing.js';

const REPEAT_EVERY_MS = 60 * 60_000; // каждый час
const ALERT_REDIS_KEY = 'billing:alert:last_threshold_kopecks';
const ALERT_TTL_S = 24 * 3600;

export interface BillingAlertDeps {
  pool: Pool;
}

export function createBillingAlertWorker(deps: BillingAlertDeps): Worker {
  const worker = new Worker(
    QUEUE_NAMES.BILLING_ALERT,
    async (_job: Job) => processTick(deps),
    { connection: createRedisClient(), concurrency: 1 },
  );
  worker.on('failed', (_job, err) => {
    log.error(
      { queue: QUEUE_NAMES.BILLING_ALERT, err: err.message },
      'billing-alert: tick failed',
    );
  });
  return worker;
}

export async function scheduleBillingAlertCron(): Promise<void> {
  try {
    await billingAlertQueue().add(
      'billing-check',
      {},
      { repeat: { every: REPEAT_EVERY_MS }, jobId: 'billing-alert-tick', removeOnComplete: true },
    );
    log.info({ everyMs: REPEAT_EVERY_MS }, 'billing-alert cron: scheduled');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'billing-alert cron: schedule failed');
  }
}

async function processTick(deps: BillingAlertDeps): Promise<{ alerted: boolean; cost: number }> {
  const threshold = config.BILLING_DAILY_ALERT_KOPECKS;
  const cost = await dailyCostKopecks(deps.pool);

  if (cost <= threshold) {
    log.debug({ costKopecks: cost, thresholdKopecks: threshold }, 'billing-alert: under threshold');
    return { alerted: false, cost };
  }

  // Дедуп: если уже алертили на этот порог сегодня — пропускаем.
  // Берём ceil(cost/threshold) — алертим каждый раз когда расход переваливает
  // на новую кратность threshold (500₽, 1000₽, 1500₽...).
  const bucket = Math.floor(cost / threshold);
  const cachedRaw = await redis.get(ALERT_REDIS_KEY);
  const cached = cachedRaw ? Number(cachedRaw) : 0;
  if (cached >= bucket) {
    log.debug(
      { costKopecks: cost, bucket, cachedBucket: cached },
      'billing-alert: already alerted for this bucket',
    );
    return { alerted: false, cost };
  }

  // Алерт.
  const summary = await getBillingSummary(deps.pool, 'today');
  await sendTelegramAlert(cost, threshold, summary);
  await redis.set(ALERT_REDIS_KEY, String(bucket), 'EX', ALERT_TTL_S);
  log.warn(
    { costKopecks: cost, costRub: (cost / 100).toFixed(2), thresholdKopecks: threshold, bucket },
    'billing-alert: TG sent (cost > threshold)',
  );
  return { alerted: true, cost };
}

async function sendTelegramAlert(
  costKopecks: number,
  thresholdKopecks: number,
  summary: Awaited<ReturnType<typeof getBillingSummary>>,
): Promise<void> {
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.YE_TG_USER_ID;
  if (!token || !chatId) {
    log.warn({}, 'billing-alert: no TG token/chatId — skip');
    return;
  }

  const costRub = (costKopecks / 100).toFixed(2);
  const thresholdRub = (thresholdKopecks / 100).toFixed(0);

  const byModelLines = summary.by_model
    .slice(0, 5)
    .map(
      (m) =>
        `  • ${m.model} (${m.provider}): ${m.count_ok} шт × ${(m.total_rub / Math.max(m.count_ok, 1)).toFixed(2)}₽ = ${m.total_rub.toFixed(2)}₽`,
    )
    .join('\n');

  const text =
    `💰 Превышение суточного расхода на AI-картинки\n\n` +
    `За последние 24h: *${costRub} ₽* (порог: ${thresholdRub} ₽)\n` +
    `Успешных генераций: ${summary.totals.count_ok}\n` +
    `Ошибок: ${summary.totals.count_error}\n\n` +
    `По моделям:\n${byModelLines || '  —'}\n\n` +
    `Если расход в норме — игнорируй. Если нет — выключи IMAGE_PROVIDER на placeholder/template.`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    log.error({ status: res.status, body: t.slice(0, 200) }, 'billing-alert: TG sendMessage failed');
  }
}
