// funnel-worker — обрабатывает funnel_queue (SPEC §2.10).
// Виды job'ов:
//   - longread_delivery → sendLongreadToDirect
//   - club_upsell       → upgradeToClub (единственный CTA, CLAUDE.md §1 sacred)
//
// Сюда не льётся LLM (CLAUDE.md «LLM — только через очередь, не из webhook»);
// сама очередь — целевая точка отвязки от Fastify webhook handler'а.

import { Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES, type FunnelJobData } from './queues.js';
import {
  sendLongreadToDirect,
  upgradeToClub,
  type FunnelDeps,
} from '../services/funnel.js';

export interface FunnelWorkerDeps {
  pool: Pool;
  concurrency?: number;
  /** Опциональный override ChatPlace клиента (для тестов). */
  chatplace?: FunnelDeps['chatplace'];
}

export interface FunnelWorkerResult {
  status: 'ok' | 'skipped' | 'error';
  kind: FunnelJobData['kind'];
  subscriberId: string;
  reason?: string;
}

export function createFunnelWorker(
  deps: FunnelWorkerDeps,
): Worker<FunnelJobData, FunnelWorkerResult> {
  const worker = new Worker<FunnelJobData, FunnelWorkerResult>(
    QUEUE_NAMES.FUNNEL,
    async (job) => process(job, deps),
    { connection: createRedisClient(), concurrency: deps.concurrency ?? 2 },
  );
  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, queue: QUEUE_NAMES.FUNNEL, err: err.message },
      'funnel-worker: job failed',
    );
  });
  worker.on('completed', (job, result) => {
    log.info(
      { jobId: job.id, queue: QUEUE_NAMES.FUNNEL, ...result },
      'funnel-worker: job completed',
    );
  });
  return worker;
}

async function process(
  job: Job<FunnelJobData>,
  deps: FunnelWorkerDeps,
): Promise<FunnelWorkerResult> {
  const data = job.data;
  const funnelDeps: FunnelDeps = { pool: deps.pool };
  if (deps.chatplace) funnelDeps.chatplace = deps.chatplace;

  switch (data.kind) {
    case 'longread_delivery': {
      const r = await sendLongreadToDirect(data.subscriber_id, data.bonus_id, funnelDeps, {
        funnelId: data.funnel_id ?? null,
        codeWord: data.code_word ?? null,
        ...(data.chatplace_subscriber_id
          ? { chatplaceSubscriberId: data.chatplace_subscriber_id }
          : {}),
      });
      return {
        status: r.delivered ? 'ok' : 'skipped',
        kind: data.kind,
        subscriberId: data.subscriber_id,
        ...(r.reason ? { reason: r.reason } : {}),
      };
    }
    case 'club_upsell': {
      const r = await upgradeToClub(data.subscriber_id, funnelDeps, {
        funnelId: data.funnel_id ?? null,
        codeWord: data.code_word ?? null,
        ...(data.chatplace_subscriber_id
          ? { chatplaceSubscriberId: data.chatplace_subscriber_id }
          : {}),
      });
      return {
        status: r.pushed ? 'ok' : 'skipped',
        kind: data.kind,
        subscriberId: data.subscriber_id,
        ...(r.reason ? { reason: r.reason } : {}),
      };
    }
  }
}
