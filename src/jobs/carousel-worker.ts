// Воркер 'visual_queue': принимает {content_package_id, idea_id, style_hint?},
// вызывает carousel-renderer (Nano Banana → Sharp → Cloudinary).
//
// Воркер CPU+IO-bound (sharp + uploads), concurrency=1 на инстанс по умолчанию.

import { Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES, type VisualJobData } from './queues.js';
import { renderCarousel } from '../services/carousel-renderer.js';
import { notifyApprovalReady } from '../services/approval-notifier.js';

export interface CarouselWorkerDeps {
  pool: Pool;
  concurrency?: number;
}

export interface CarouselWorkerResult {
  status: 'ok' | 'skipped' | 'error';
  contentPackageId: string;
  slidesRendered?: number;
  totalDurationMs?: number;
  reason?: string;
}

export function createCarouselWorker(
  deps: CarouselWorkerDeps,
): Worker<VisualJobData, CarouselWorkerResult> {
  const worker = new Worker<VisualJobData, CarouselWorkerResult>(
    QUEUE_NAMES.VISUAL,
    async (job) => process(job, deps),
    {
      connection: createRedisClient(),
      concurrency: deps.concurrency ?? 1,
    },
  );
  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, queue: QUEUE_NAMES.VISUAL, err: err.message },
      'carousel-worker: job failed',
    );
  });
  worker.on('completed', (job, result) => {
    log.info(
      { jobId: job.id, queue: QUEUE_NAMES.VISUAL, ...result },
      'carousel-worker: job completed',
    );
  });
  return worker;
}

async function process(
  job: Job<VisualJobData>,
  deps: CarouselWorkerDeps,
): Promise<CarouselWorkerResult> {
  const { content_package_id, style_hint } = job.data;
  if (!content_package_id) {
    return { status: 'skipped', contentPackageId: '', reason: 'no content_package_id' };
  }
  try {
    const renderInput: Parameters<typeof renderCarousel>[0] = {
      contentPackageId: content_package_id,
    };
    if (style_hint) renderInput.styleHint = style_hint;
    const res = await renderCarousel(renderInput, { pool: deps.pool });

    // SPEC §2.8 AC-22 (упрощённо): после рендера каруселей шлём готовый
    // пакет Юрию в Telegram. Без этого Юрий не узнаёт что контент готов.
    try {
      await notifyApprovalReady(
        { contentPackageId: res.contentPackageId },
        { pool: deps.pool },
      );
    } catch (err) {
      log.warn(
        { contentPackageId: res.contentPackageId, err: (err as Error).message },
        'carousel-worker: notifyApprovalReady failed (non-fatal)',
      );
    }

    return {
      status: 'ok',
      contentPackageId: res.contentPackageId,
      slidesRendered: res.slides.length,
      totalDurationMs: res.totalDurationMs,
    };
  } catch (err) {
    log.error(
      { contentPackageId: content_package_id, err: (err as Error).message },
      'carousel-worker: render failed',
    );
    // Не throw — иначе jobs будут зацикливаться в очереди при стабильной ошибке.
    // Логи покажут проблему, BullMQ всё равно сделает retry по defaultJobOptions.
    // Пока возвращаем ошибочный результат — на следующей итерации поправим логику.
    throw err;
  }
}
