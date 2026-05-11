// Воркер 'audio_queue': транскрибирует voice/audio через Deepgram и пишет idea.
// SPEC §3.5 — concurrency 3, retry 3× exp backoff (опции в queues.ts).
//
// Воркер запускается из bootstrap-кода через createSttWorker(deps).

import { Worker, type Job } from 'bullmq';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';
import { transcribe, type SttResult } from '../services/stt.js';
import { QUEUE_NAMES, type SttJobData } from './queues.js';
import type { Pool } from 'pg';

export interface SttWorkerDeps {
  pool: Pool;
  /** Разрешает Telegram file_id → прямой URL для скачивания (через bot.api.getFile). */
  resolveTgFileUrl: (fileId: string) => Promise<string>;
  concurrency?: number;
}

export interface SttWorkerResult {
  status: 'ok' | 'skipped' | 'unavailable' | 'error';
  ideaId?: string;
  text?: string;
  reason?: string;
}

export function createSttWorker(deps: SttWorkerDeps): Worker<SttJobData, SttWorkerResult> {
  const worker = new Worker<SttJobData, SttWorkerResult>(
    QUEUE_NAMES.AUDIO,
    async (job: Job<SttJobData>) => process(job, deps),
    {
      connection: createRedisClient(),
      concurrency: deps.concurrency ?? 3,
    },
  );

  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, queue: QUEUE_NAMES.AUDIO, err: err.message },
      'stt-worker: job failed',
    );
  });
  worker.on('completed', (job, result) => {
    log.info(
      { jobId: job.id, queue: QUEUE_NAMES.AUDIO, status: result.status },
      'stt-worker: job completed',
    );
  });
  return worker;
}

async function process(
  job: Job<SttJobData>,
  deps: SttWorkerDeps,
): Promise<SttWorkerResult> {
  const data = job.data;
  const url =
    data.source.kind === 'url'
      ? data.source.url
      : await deps.resolveTgFileUrl(data.source.fileId);

  const sttResult: SttResult = await transcribe({
    kind: 'url',
    url,
    ...(data.mime_type ? { mimeType: data.mime_type } : {}),
  });

  if (sttResult.status === 'unavailable') {
    return { status: 'unavailable', reason: sttResult.reason };
  }
  if (sttResult.status === 'error') {
    throw new Error(`stt failed: ${sttResult.reason}`);
  }

  // Пишем идею с source='voice'. pain_tag/summary заполнятся в следующих фазах.
  const insertSql = `
    INSERT INTO ideas (source, raw_transcript, status)
    VALUES ($1, $2, 'new')
    RETURNING id
  `;
  const res = await deps.pool.query<{ id: string }>(insertSql, ['voice', sttResult.text]);
  const ideaId = res.rows[0]?.id;
  if (!ideaId) {
    throw new Error('stt-worker: ideas insert returned no id');
  }
  log.info(
    {
      ideaId,
      tg_user_id: data.tg_user_id,
      message_id: data.message_id,
      duration_sec: data.duration_sec,
      language: sttResult.language,
      confidence: sttResult.confidence,
    },
    'stt-worker: idea created from voice',
  );
  return { status: 'ok', ideaId, text: sttResult.text };
}
