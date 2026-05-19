// warmup-sender-worker — BullMQ repeatable job каждые 5 минут.
// SELECT warmup_messages WHERE status='pending' AND scheduled_at <= NOW()
// → Telegram bot API sendMessage → UPDATE status='sent'.
//
// Также сюда же: AC-30 detector — после 7 дней без 'paid' переключает
// subscriber.status='warming' → запускает chain_type='long'.

import type { Pool } from 'pg';
import { Worker, type Job } from 'bullmq';
import { createRedisClient } from '../redis.js';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES } from './queues.js';

const PROCESS_BATCH = 25;
const REPEAT_EVERY_MS = 5 * 60_000; // 5 минут
const QUEUE_KEY = 'warmup-tick';

export interface WarmupSenderDeps {
  pool: Pool;
}

interface PendingRow {
  id: string;
  subscriber_id: string;
  tg_user_id: string;
  body_md: string;
  cta_url: string | null;
  step: number;
  chain_type: 'short' | 'long';
}

export function createWarmupSenderWorker(deps: WarmupSenderDeps): Worker {
  const worker = new Worker(
    QUEUE_NAMES.WARMUP,
    async (_job: Job) => processTick(deps),
    { connection: createRedisClient(), concurrency: 1 },
  );
  worker.on('failed', (_job, err) => {
    log.error({ queue: QUEUE_NAMES.WARMUP, err: err.message }, 'warmup-sender: tick failed');
  });
  return worker;
}

/** Планирует repeatable job каждые 5 мин. */
export async function scheduleWarmupSenderCron(): Promise<void> {
  const { warmupQueue } = await import('./queues.js');
  try {
    await warmupQueue().add(
      'send-tick',
      {},
      { repeat: { every: REPEAT_EVERY_MS }, jobId: QUEUE_KEY, removeOnComplete: true },
    );
    log.info({ everyMs: REPEAT_EVERY_MS }, 'warmup-sender cron: scheduled');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'warmup-sender cron: schedule failed');
  }
}

async function processTick(
  deps: WarmupSenderDeps,
): Promise<{ sent: number; failed: number; longChainsKicked: number }> {
  // 1) Найти готовые к отправке сообщения.
  const rowsRes = await deps.pool.query<PendingRow>(
    `SELECT wm.id, wm.subscriber_id, wm.body_md, wm.cta_url, wm.step, wm.chain_type,
            s.tg_user_id::text AS tg_user_id
       FROM warmup_messages wm
       JOIN subscribers s ON s.id = wm.subscriber_id
      WHERE wm.status = 'pending'
        AND wm.scheduled_at <= NOW()
        AND s.tg_user_id IS NOT NULL
        AND s.deleted_at IS NULL
      ORDER BY wm.scheduled_at ASC
      LIMIT $1`,
    [PROCESS_BATCH],
  );

  let sent = 0;
  let failed = 0;
  for (const row of rowsRes.rows) {
    try {
      const messageId = await sendTgMessage(Number(row.tg_user_id), row.body_md);
      await deps.pool.query(
        `UPDATE warmup_messages
            SET status = 'sent', sent_at = NOW(), tg_message_id = $2
          WHERE id = $1`,
        [row.id, messageId],
      );
      log.info(
        {
          warmupId: row.id,
          subscriberId: row.subscriber_id,
          step: row.step,
          chainType: row.chain_type,
        },
        'warmup-sender: message sent',
      );
      sent++;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      await deps.pool.query(
        `UPDATE warmup_messages SET status = 'failed', fail_reason = $2 WHERE id = $1`,
        [row.id, msg],
      );
      log.warn(
        { warmupId: row.id, err: msg },
        'warmup-sender: send failed',
      );
      failed++;
    }
  }

  // 2) AC-30: ищем subscribers со status='warming' где первая short-цепочка
  // отправлена > 7 дней назад, оплаты нет → запускаем long.
  const longChainsKicked = await maybeStartLongChain(deps.pool);

  if (sent + failed + longChainsKicked > 0) {
    log.info({ sent, failed, longChainsKicked }, 'warmup-sender: tick done');
  }
  return { sent, failed, longChainsKicked };
}

async function sendTgMessage(chatId: number, text: string): Promise<number> {
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('warmup-sender: TELEGRAM_BOT_TOKEN not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4000),
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`tg sendMessage HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { result?: { message_id?: number } };
  return j.result?.message_id ?? 0;
}

/**
 * AC-30: подписчики со status='warming' у которых short-цепочка вся отправлена
 * > 7 дней назад и нет события 'club_purchased' → переключаем на long chain.
 */
async function maybeStartLongChain(pool: Pool): Promise<number> {
  // Берём кандидатов: subscriber + funnel где:
  //   - последний step short цепочки sent > 7 дней назад
  //   - long цепочка ещё не создана
  //   - в funnel_events нет club_purchased для этого subscriber
  const cands = await pool.query<{ subscriber_id: string; funnel_id: string; code_word: string }>(
    `WITH last_short AS (
       SELECT subscriber_id, funnel_id, MAX(sent_at) AS last_sent
         FROM warmup_messages
        WHERE chain_type = 'short' AND status = 'sent'
        GROUP BY subscriber_id, funnel_id
        HAVING MAX(sent_at) < NOW() - INTERVAL '7 days'
     )
     SELECT ls.subscriber_id, ls.funnel_id, f.code_word
       FROM last_short ls
       JOIN funnels f ON f.id = ls.funnel_id
       LEFT JOIN warmup_messages long_wm
              ON long_wm.subscriber_id = ls.subscriber_id
             AND long_wm.funnel_id = ls.funnel_id
             AND long_wm.chain_type = 'long'
       LEFT JOIN funnel_events fe
              ON fe.subscriber_id = ls.subscriber_id
             AND fe.event_type = 'club_purchased'
      WHERE long_wm.id IS NULL
        AND fe.id IS NULL
      LIMIT 20`,
  );

  if (cands.rows.length === 0) return 0;

  const { scheduleWarmupChain } = await import('../services/warmup-scheduler.js');
  let kicked = 0;
  for (const c of cands.rows) {
    try {
      const r = await scheduleWarmupChain(pool, {
        subscriberId: c.subscriber_id,
        funnelId: c.funnel_id,
        codeWord: c.code_word,
        chainType: 'long',
      });
      if (r.inserted > 0) {
        log.info(
          { subscriberId: c.subscriber_id, funnelId: c.funnel_id, codeWord: c.code_word },
          'warmup-sender: kicked off long chain (AC-30)',
        );
        kicked++;
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message, subscriberId: c.subscriber_id },
        'warmup-sender: long chain kickoff failed',
      );
    }
  }
  return kicked;
}
