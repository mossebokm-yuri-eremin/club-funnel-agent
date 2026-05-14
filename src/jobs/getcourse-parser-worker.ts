// getcourse-parser-worker — раз в 10 секунд берёт pending записи из
// getcourse_raw_events, парсит через gc-payload-parser, обновляет
// subscribers и (если оплата клуба) шлёт Telegram-уведомление Юрию.
//
// Дизайн: repeatable cron-job в BullMQ. Сам worker НЕ принимает данные —
// он каждый запуск читает 50 pending rows из БД, обрабатывает их и завершается.

import type { Pool } from 'pg';
import { Worker, type Job } from 'bullmq';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES, getCourseParseQueue } from './queues.js';
import { parseGcPayload, isClubPayment } from '../services/gc-payload-parser.js';
import { config } from '../config.js';

const PARSE_BATCH = 50;
const REPEAT_EVERY_MS = 10_000;
const REPEAT_KEY = 'gc-parse-tick';

export interface GcParserDeps {
  pool: Pool;
}

interface RawEventRow {
  id: string;
  raw_payload: unknown;
}

export function createGetCourseParserWorker(deps: GcParserDeps): Worker {
  const worker = new Worker(
    QUEUE_NAMES.GETCOURSE_PARSE,
    async (_job: Job) => processBatch(deps),
    { connection: createRedisClient(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) => {
    log.error(
      { queue: QUEUE_NAMES.GETCOURSE_PARSE, err: err.message },
      'gc-parser-worker: tick failed',
    );
  });

  return worker;
}

/** Планирует repeatable job каждые 10 секунд. Idempotent: BullMQ упадёт без шума на повторе. */
export async function scheduleGetCourseParserCron(): Promise<void> {
  const q = getCourseParseQueue();
  try {
    await q.add(
      'parse-tick',
      {},
      { repeat: { every: REPEAT_EVERY_MS }, jobId: REPEAT_KEY, removeOnComplete: true },
    );
    log.info({ everyMs: REPEAT_EVERY_MS }, 'gc-parser cron: scheduled');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'gc-parser cron: schedule failed (continuing)');
  }
}

async function processBatch(deps: GcParserDeps): Promise<{ processed: number; club_purchases: number }> {
  const rowsRes = await deps.pool.query<RawEventRow>(
    `SELECT id, raw_payload
       FROM getcourse_raw_events
      WHERE parse_status = 'pending'
      ORDER BY received_at ASC
      LIMIT $1`,
    [PARSE_BATCH],
  );
  if (rowsRes.rows.length === 0) return { processed: 0, club_purchases: 0 };

  let clubPurchases = 0;

  for (const row of rowsRes.rows) {
    try {
      const parsed = parseGcPayload(row.raw_payload);

      if (parsed.empty) {
        await deps.pool.query(
          `UPDATE getcourse_raw_events
              SET parse_status = 'ignored',
                  parse_error = 'no recognized GC fields',
                  parsed_at = NOW()
            WHERE id = $1`,
          [row.id],
        );
        continue;
      }

      // Проверяем — оплата нашего клуба?
      const isClub = isClubPayment(parsed, config.GC_BASE_OFFER_ID ? String(config.GC_BASE_OFFER_ID) : null);

      // Upsert subscriber если есть email и это оплата клуба.
      // Текущая схема subscribers не имеет gc_user_id/name/utm_*, поэтому метаданные кладём
      // в notes как JSON. UNIQUE индекс — по lower(email) (см. миграцию 001).
      if (parsed.userEmail && parsed.eventType === 'club_purchased') {
        const notesJson = JSON.stringify({
          gc_user_id: parsed.userId,
          full_name: parsed.userFullName,
          utm_source: parsed.utmSource,
          utm_campaign: parsed.utmCampaign,
          utm_content: parsed.utmContent,
          payment_id: parsed.paymentId,
          product_id: parsed.productId,
          source: 'getcourse_webhook',
        });
        try {
          await deps.pool.query(
            `INSERT INTO subscribers (email, phone, status, club_paid_at, notes)
               VALUES ($1, $2, 'paid', COALESCE($3::timestamptz, NOW()), $4)
             ON CONFLICT (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL
               DO UPDATE
                  SET phone = COALESCE(EXCLUDED.phone, subscribers.phone),
                      status = 'paid',
                      club_paid_at = COALESCE(EXCLUDED.club_paid_at, subscribers.club_paid_at),
                      last_seen_at = NOW(),
                      notes = COALESCE(EXCLUDED.notes, subscribers.notes)`,
            [parsed.userEmail, parsed.userPhone, parsed.paidAt, notesJson],
          );
        } catch (err) {
          log.warn(
            { rawId: row.id, err: (err as Error).message },
            'gc-parser: subscribers upsert failed (продолжаем парсинг)',
          );
        }
      }

      // Обновляем raw_event как parsed
      await deps.pool.query(
        `UPDATE getcourse_raw_events
            SET parse_status = 'parsed',
                parsed_event_type = $2,
                parsed_user_email = $3,
                parsed_amount_kopecks = $4,
                parsed_at = NOW()
          WHERE id = $1`,
        [row.id, parsed.eventType, parsed.userEmail, parsed.amountKopecks],
      );

      // Если оплата клуба — шлём Telegram уведомление Юрию.
      if (isClub) {
        clubPurchases++;
        await notifyYuriClubPurchase(deps.pool, row.id, parsed).catch((e) => {
          log.warn(
            { rawId: row.id, err: (e as Error).message },
            'gc-parser: tg notify failed (non-fatal)',
          );
        });
      }
    } catch (err) {
      await deps.pool
        .query(
          `UPDATE getcourse_raw_events
              SET parse_status = 'error',
                  parse_error = $2,
                  parsed_at = NOW()
            WHERE id = $1`,
          [row.id, (err as Error).message],
        )
        .catch(() => {});
      log.error(
        { rawId: row.id, err: (err as Error).message },
        'gc-parser: row parse failed',
      );
    }
  }

  log.info(
    { processed: rowsRes.rows.length, club_purchases: clubPurchases },
    'gc-parser: batch done',
  );
  return { processed: rowsRes.rows.length, club_purchases: clubPurchases };
}

async function notifyYuriClubPurchase(
  pool: Pool,
  rawId: string,
  parsed: ReturnType<typeof parseGcPayload>,
): Promise<void> {
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.YE_TG_USER_ID;
  if (!token || !chatId) {
    log.warn({}, 'gc-parser: no TELEGRAM_BOT_TOKEN/YE_TG_USER_ID — skipping notify');
    return;
  }
  const amountRub = (parsed.amountKopecks / 100).toFixed(2);
  const lines: string[] = [
    '🎉 Новая оплата клуба',
    `Имя: ${parsed.userFullName ?? '—'}`,
    `Email: ${parsed.userEmail ?? '—'}`,
    `Сумма: ${amountRub} ₽`,
    `UTM: ${parsed.utmSource ?? '—'} / ${parsed.utmCampaign ?? '—'}`,
    `Время: ${parsed.paidAt ?? '—'}`,
    `payment_id: ${parsed.paymentId ?? '—'}`,
  ];
  const body = {
    chat_id: chatId,
    text: lines.join('\n'),
    disable_web_page_preview: true,
  };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`tg sendMessage HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  await pool.query(
    `UPDATE getcourse_raw_events SET notified_at = NOW() WHERE id = $1`,
    [rawId],
  );
}
