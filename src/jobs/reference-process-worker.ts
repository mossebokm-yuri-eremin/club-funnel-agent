// Воркер 'reference_process_queue': SPEC §2.13 AC-39 + AC-40.
//
// Поток:
//   1. INSERT в references_inbox уже сделан reference-detect-worker.
//   2. Этот воркер качает медиа (yt-dlp → RapidAPI) → UPDATE local_path,
//      download_status, download_provider.
//   3. Прогоняет Gemini 2.5 Pro Video → transcript + visual_analysis.
//   4. Обновляет references_inbox, возвращает referenceId/transcript-len.
//
// Если у source_url нет (например video_file прислан напрямую в TG, а не IG-URL),
// шаг 2 пропускается — caller заранее положил local_path.

import { Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import path from 'node:path';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES, type ReferenceProcessJobData } from './queues.js';
import { downloadInstagram } from '../integrations/ytdlp.js';
import { analyzeVideo } from '../integrations/gemini-video.js';
import { config } from '../config.js';

export interface ReferenceProcessWorkerDeps {
  pool: Pool;
  concurrency?: number;
}

export interface ReferenceProcessWorkerResult {
  status: 'ok' | 'skipped' | 'error';
  referenceId: string;
  provider?: string;
  transcriptLen?: number;
  reason?: string;
}

export function createReferenceProcessWorker(
  deps: ReferenceProcessWorkerDeps,
): Worker<ReferenceProcessJobData, ReferenceProcessWorkerResult> {
  const worker = new Worker<ReferenceProcessJobData, ReferenceProcessWorkerResult>(
    QUEUE_NAMES.REFERENCE_PROCESS,
    async (job) => process(job, deps),
    {
      connection: createRedisClient(),
      concurrency: deps.concurrency ?? 1,
    },
  );
  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, queue: QUEUE_NAMES.REFERENCE_PROCESS, err: err.message },
      'reference-process-worker: job failed',
    );
  });
  worker.on('completed', (job, result) => {
    log.info(
      { jobId: job.id, status: result.status, referenceId: result.referenceId },
      'reference-process-worker: job completed',
    );
  });
  return worker;
}

interface RefRow {
  id: string;
  source_url: string | null;
  source_type: 'reel' | 'carousel' | 'post' | 'video_file';
  local_path: string | null;
  download_status: 'pending' | 'downloaded' | 'failed';
}

async function fetchRef(pool: Pool, id: string): Promise<RefRow | null> {
  const r = await pool.query<RefRow>(
    `SELECT id, source_url, source_type, local_path, download_status
       FROM references_inbox
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function process(
  job: Job<ReferenceProcessJobData>,
  deps: ReferenceProcessWorkerDeps,
): Promise<ReferenceProcessWorkerResult> {
  const data = job.data;
  const ref = await fetchRef(deps.pool, data.reference_id);
  if (!ref) {
    return { status: 'skipped', referenceId: data.reference_id, reason: 'not found' };
  }

  // 1) Скачивание (если local_path ещё не задан).
  let localPath = ref.local_path;
  let provider: string | undefined;
  if (!localPath && data.source_url) {
    const outPath = path.join(config.REFS_DIR, `${ref.id}.mp4`);
    try {
      const dl = await downloadInstagram({ url: data.source_url, outPath });
      localPath = dl.localPath;
      provider = dl.provider;
      await deps.pool.query(
        `UPDATE references_inbox
            SET local_path = $2, download_provider = $3, download_status = 'downloaded',
                updated_at = NOW()
          WHERE id = $1`,
        [ref.id, localPath, provider],
      );
    } catch (err) {
      await deps.pool.query(
        `UPDATE references_inbox
            SET download_status = 'failed', updated_at = NOW()
          WHERE id = $1`,
        [ref.id],
      );
      log.error(
        { referenceId: ref.id, source_url: data.source_url, err: (err as Error).message },
        'reference-process-worker: download failed (yt-dlp + RapidAPI both)',
      );
      throw err;
    }
  } else if (!localPath) {
    return {
      status: 'skipped',
      referenceId: ref.id,
      reason: 'no source_url and no local_path — manual upload expected',
    };
  }

  // 2) Анализ через Gemini 2.5 Pro Video.
  const assetKind = data.source_type === 'video_file' ? 'reel' : data.source_type;
  const analysis = await analyzeVideo({ localPath, assetKind });

  // 3) UPDATE references_inbox.
  await deps.pool.query(
    `UPDATE references_inbox
        SET transcript = $2,
            visual_analysis = $3::jsonb,
            ocr_text = $4,
            updated_at = NOW()
      WHERE id = $1`,
    [
      ref.id,
      analysis.transcript,
      JSON.stringify(analysis.visual),
      analysis.visual.onscreen_text.join('\n'),
    ],
  );

  const result: ReferenceProcessWorkerResult = {
    status: 'ok',
    referenceId: ref.id,
    transcriptLen: analysis.transcript.length,
  };
  if (provider) result.provider = provider;
  return result;
}
