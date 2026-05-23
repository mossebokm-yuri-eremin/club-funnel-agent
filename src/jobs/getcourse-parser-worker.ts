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
  query_params: unknown;
  body_parsed: unknown;
}

/** Объединяет query_params + body_parsed + raw_payload (legacy) в один объект для парсера. */
function mergeForParse(row: RawEventRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const src of [row.query_params, row.body_parsed, row.raw_payload]) {
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      Object.assign(out, src as Record<string, unknown>);
    }
  }
  return out;
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

/** Сбросить parse_status='pending' для одной записи (для /admin/getcourse/retry/:id). */
export async function retryOneEvent(pool: Pool, id: string | number): Promise<boolean> {
  const r = await pool.query(
    `UPDATE getcourse_raw_events
        SET parse_status = 'pending', parse_error = NULL, parsed_at = NULL
      WHERE id = $1
      RETURNING id`,
    [id],
  );
  return r.rowCount === 1;
}

async function processBatch(deps: GcParserDeps): Promise<{ processed: number; club_purchases: number }> {
  const rowsRes = await deps.pool.query<RawEventRow>(
    `SELECT id, raw_payload, query_params, body_parsed
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
      const merged = mergeForParse(row);
      const parsed = parseGcPayload(merged);

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
      const isClub = isClubPayment(parsed, {
        baseOfferId: config.GC_BASE_OFFER_ID ? String(config.GC_BASE_OFFER_ID) : null,
        clubOfferIds: config.CLUB_OFFER_IDS,
        clubOfferNameMatch: config.CLUB_OFFER_NAME_MATCH,
      });

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
          const upRes = await deps.pool.query<{ id: string; tg_user_id: string | null; club_paid_at_was: string | null }>(
            `WITH upserted AS (
               INSERT INTO subscribers (email, phone, status, club_paid_at, notes)
                 VALUES ($1, $2, 'paid', COALESCE($3::timestamptz, NOW()), $4)
               ON CONFLICT (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL
                 DO UPDATE
                    SET phone = COALESCE(EXCLUDED.phone, subscribers.phone),
                        status = 'paid',
                        club_paid_at = COALESCE(subscribers.club_paid_at, EXCLUDED.club_paid_at),
                        last_seen_at = NOW(),
                        notes = COALESCE(EXCLUDED.notes, subscribers.notes)
               RETURNING id, tg_user_id, (xmax = 0) AS was_inserted
             )
             SELECT id, tg_user_id::text, NULL::text AS club_paid_at_was FROM upserted`,
            [parsed.userEmail, parsed.userPhone, parsed.paidAt, notesJson],
          );
          const sub = upRes.rows[0];
          // Если у подписчика есть tg_user_id — шлём ему invite в чат клуба.
          if (sub?.tg_user_id && config.CLUB_TG_INVITE_URL) {
            await sendClubInviteToTg(sub.tg_user_id, parsed.userFullName ?? '').catch((err) => {
              log.warn(
                { rawId: row.id, tgUserId: sub.tg_user_id, err: (err as Error).message },
                'gc-parser: club invite TG send failed (non-fatal)',
              );
            });
          } else if (sub && !sub.tg_user_id) {
            log.info(
              { rawId: row.id, subscriberId: sub.id, email: parsed.userEmail },
              'gc-parser: paid subscriber has no tg_user_id — manual onboarding needed',
            );
          } else if (sub?.tg_user_id && !config.CLUB_TG_INVITE_URL) {
            log.warn(
              { rawId: row.id },
              'gc-parser: CLUB_TG_INVITE_URL not configured — paid subscriber will NOT receive auto-invite',
            );
          }
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
                parsed_order_id = $5,
                parsed_at = NOW()
          WHERE id = $1`,
        [row.id, parsed.eventType, parsed.userEmail, parsed.amountKopecks, parsed.paymentId],
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


// ─── post-payment helper: invite в TG-чат клуба ────────────────────────────
async function sendClubInviteToTg(tgUserId: string | number, userName: string): Promise<void> {
  const token = config.TELEGRAM_BOT_TOKEN;
  const invite = config.CLUB_TG_INVITE_URL;
  if (!token || !invite) return;
  const name = userName.replace(/_/g, ' ').trim();
  const greeting = name ? `${name}, ` : '';
  const groupName = config.CLUB_TG_GROUP_NAME ?? 'Реализация';
  const text =
    `🎉 ${greeting}поздравляю!\n\n` +
    `Оплата клуба «${groupName}» прошла. Вот ссылка чтобы вступить в закрытый чат:\n\n` +
    `${invite}\n\n` +
    `Внутри — еженедельные эфиры со мной, разборы проектов резидентов, чат единомышленников.\n\n` +
    `Заходи. Юрий 🤝`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: tgUserId,
      text,
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`tg sendMessage HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  log.info({ tgUserId, groupName, inviteSet: !!invite }, 'gc-parser: club invite sent to subscriber');
}
