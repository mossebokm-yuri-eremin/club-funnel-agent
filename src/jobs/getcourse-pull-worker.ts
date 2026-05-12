// getcourse-pull-worker — SPEC §2.11 AC-31: hourly cron к GetCourse API для
// сверки подписчиков клуба и статусов ордеров.
//
// Запуск: в src/index.ts шедулим JobsOptions.repeat = CRON_GC_RECONCILE
// (по умолчанию '0 * * * *'). Здесь только сам процессор задач.
//
// На каждый pull:
//   - тянем список subscribers с group='club' (или эквивалент в GC);
//   - UPSERT в subscribers (по email/phone), обновляем status='paid'
//     и club_paid_at, если у GC subscriber.status='active'/'paid';
//   - пишем funnel_events.event_type='cron_pull' с idempotency_key для аудита.
//
// Деньги тут не трогаем — суммы приходят через webhook (payments).

import { Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES, type GetCoursePullJobData } from './queues.js';
import { createGetCourseClient, type GcClient, type GcSubscriber } from '../integrations/getcourse.js';
import { trackEvent } from '../services/funnel.js';

export interface GetCoursePullWorkerDeps {
  pool: Pool;
  concurrency?: number;
  client?: GcClient;
  /** Группа GC, маркирующая участников клуба. По умолчанию 'club'. */
  clubGroup?: string;
}

export interface GetCoursePullWorkerResult {
  status: 'ok' | 'error';
  pulled: number;
  upserted: number;
  marked_paid: number;
}

export function createGetCoursePullWorker(
  deps: GetCoursePullWorkerDeps,
): Worker<GetCoursePullJobData, GetCoursePullWorkerResult> {
  const worker = new Worker<GetCoursePullJobData, GetCoursePullWorkerResult>(
    QUEUE_NAMES.GETCOURSE_PULL,
    async (job) => process(job, deps),
    { connection: createRedisClient(), concurrency: deps.concurrency ?? 1 },
  );
  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, queue: QUEUE_NAMES.GETCOURSE_PULL, err: err.message },
      'gc-pull-worker: job failed',
    );
  });
  worker.on('completed', (job, r) => {
    log.info(
      { jobId: job.id, queue: QUEUE_NAMES.GETCOURSE_PULL, ...r },
      'gc-pull-worker: job completed',
    );
  });
  return worker;
}

async function upsertSubscriber(pool: Pool, gc: GcSubscriber): Promise<{ id: string; was_paid: boolean }> {
  // Ключи привязки: email или phone (sub_email_uniq / sub_tg_uniq не релевантен GC).
  const isPaid = ['active', 'paid', 'member'].includes((gc.status ?? '').toLowerCase());
  const sql = `
    INSERT INTO subscribers (email, phone, first_seen_at, last_seen_at, status, pd_consent_at)
    VALUES ($1, $2, NOW(), NOW(), $3, NOW())
    ON CONFLICT (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL
    DO UPDATE SET
      last_seen_at = NOW(),
      phone = COALESCE(EXCLUDED.phone, subscribers.phone),
      status = CASE WHEN EXCLUDED.status = 'paid' THEN 'paid' ELSE subscribers.status END,
      club_paid_at = CASE WHEN EXCLUDED.status = 'paid' AND subscribers.club_paid_at IS NULL
                          THEN NOW() ELSE subscribers.club_paid_at END
    RETURNING id, (status = 'paid') AS was_paid`;
  const r = await pool.query<{ id: string; was_paid: boolean }>(sql, [
    gc.email ?? null,
    gc.phone ?? null,
    isPaid ? 'paid' : 'lead',
  ]);
  return r.rows[0]!;
}

async function process(
  job: Job<GetCoursePullJobData>,
  deps: GetCoursePullWorkerDeps,
): Promise<GetCoursePullWorkerResult> {
  const client = deps.client ?? createGetCourseClient();
  const data = job.data;

  if (data.kind === 'order') {
    if (!data.order_id) {
      return { status: 'error', pulled: 0, upserted: 0, marked_paid: 0 };
    }
    const order = await client.getOrderStatus(data.order_id);
    if (order) {
      await trackEvent(
        {
          subscriberId: null,
          eventCode: 'club_purchased',
          source: 'cron_pull',
          payload: { gc_order_id: order.id, status: order.status },
          idempotencyKey: `gc_pull_order:${order.id}:${order.status}`,
        },
        { pool: deps.pool },
      );
    }
    return { status: 'ok', pulled: 1, upserted: 0, marked_paid: 0 };
  }

  const subs = await client.hourlyPullSubscribers({ groupContains: deps.clubGroup ?? 'club' });
  let upserted = 0;
  let markedPaid = 0;
  for (const s of subs) {
    if (!s.email && !s.phone) continue;
    const { id, was_paid } = await upsertSubscriber(deps.pool, s);
    upserted++;
    if (was_paid) markedPaid++;
    await trackEvent(
      {
        subscriberId: id,
        eventCode: 'gc_pull_reconcile',
        source: 'cron_pull',
        payload: { gc_subscriber_id: s.id, groups: s.groups ?? [] },
        idempotencyKey: `gc_pull_sub:${s.id}:${s.subscribed_at ?? ''}`,
      },
      { pool: deps.pool },
    );
  }
  log.info({ pulled: subs.length, upserted, markedPaid }, 'gc-pull-worker: pull complete');
  return { status: 'ok', pulled: subs.length, upserted, marked_paid: markedPaid };
}
