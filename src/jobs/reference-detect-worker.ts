// Воркер 'reference_dl_queue': сохраняет референс из IG в `references_inbox`
// со статусом 'pending_angle'. Полная загрузка через yt-dlp/RapidAPI и
// анализ через Gemini — отдельные фазы (SPEC §2.13 AC-39, AC-40).
// Здесь мы только фиксируем входной сигнал, чтобы не терять его.

import { Worker, type Job } from 'bullmq';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES, type ReferenceDetectJobData, referenceProcessQueue } from './queues.js';
import type { Pool } from 'pg';

export interface ReferenceDetectWorkerDeps {
  pool: Pool;
  concurrency?: number;
}

export interface ReferenceDetectWorkerResult {
  status: 'ok' | 'skipped' | 'error';
  referenceId?: string;
  reason?: string;
}

export function createReferenceDetectWorker(
  deps: ReferenceDetectWorkerDeps,
): Worker<ReferenceDetectJobData, ReferenceDetectWorkerResult> {
  const worker = new Worker<ReferenceDetectJobData, ReferenceDetectWorkerResult>(
    QUEUE_NAMES.REFERENCE_DL,
    async (job) => process(job, deps),
    {
      connection: createRedisClient(),
      concurrency: deps.concurrency ?? 2,
    },
  );

  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, queue: QUEUE_NAMES.REFERENCE_DL, err: err.message },
      'reference-detect-worker: job failed',
    );
  });
  worker.on('completed', (job, result) => {
    log.info(
      { jobId: job.id, status: result.status, referenceId: result.referenceId },
      'reference-detect-worker: job completed',
    );
  });
  return worker;
}

function pickSourceType(input: ReferenceDetectJobData): 'reel' | 'carousel' | 'post' | 'video_file' {
  if (input.video_file_id) return 'video_file';
  if (input.photo_file_ids && input.photo_file_ids.length > 1) return 'carousel';
  if (input.detection.mediaUrl?.includes('/reel')) return 'reel';
  return 'post';
}

async function process(
  job: Job<ReferenceDetectJobData>,
  deps: ReferenceDetectWorkerDeps,
): Promise<ReferenceDetectWorkerResult> {
  const data = job.data;
  const sourceType = pickSourceType(data);
  const insertSql = `
    INSERT INTO references_inbox (source_url, source_type, status, download_status)
    VALUES ($1, $2, 'pending_angle', 'pending')
    RETURNING id
  `;
  const res = await deps.pool.query<{ id: string }>(insertSql, [
    data.detection.mediaUrl ?? null,
    sourceType,
  ]);
  const referenceId = res.rows[0]?.id;
  if (!referenceId) {
    throw new Error('reference-detect-worker: insert returned no id');
  }
  log.info(
    {
      referenceId,
      sourceType,
      tg_user_id: data.tg_user_id,
      message_id: data.message_id,
      detectionSource: data.detection.source,
      confidence: data.detection.confidence,
    },
    'reference-detect-worker: reference saved',
  );

  // Enqueue Phase 6 пайплайна (download + Gemini Video analysis).
  // Skip если у нас нет URL для скачивания (TG video_file без IG-ссылки — manual flow).
  if (data.detection.mediaUrl) {
    try {
      await referenceProcessQueue().add('process', {
        reference_id: referenceId,
        source_url: data.detection.mediaUrl,
        source_type: sourceType,
      });
    } catch (err) {
      log.warn(
        { referenceId, err: (err as Error).message },
        'reference-detect-worker: failed to enqueue process (continuing)',
      );
    }
  }

  return { status: 'ok', referenceId };
}
