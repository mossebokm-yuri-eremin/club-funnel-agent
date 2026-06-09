// Воркер 'visual_queue': принимает {content_package_id, idea_id},
// вызывает carousel-renderer (Seedream style-transfer → Sharp overlay → Cloudinary).
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
  const { content_package_id } = job.data;
  if (!content_package_id) {
    return { status: 'skipped', contentPackageId: '', reason: 'no content_package_id' };
  }
  let renderRes: Awaited<ReturnType<typeof renderCarousel>> | null = null;
  let renderErr: Error | null = null;

  try {
    renderRes = await renderCarousel(
      { contentPackageId: content_package_id },
      { pool: deps.pool },
    );
  } catch (err) {
    renderErr = err as Error;
    log.error(
      { contentPackageId: content_package_id, err: renderErr.message },
      'carousel-worker: render failed (insufficient balance / API error — текстовый пакет всё равно отправим)',
    );
  }

  // ТЗ Юрия 2026-06-09: ВСЕГДА вызываем notifyApprovalReady, даже если render
  // упал (например, GPTunnel баланс = 0). Тексты пакета и slides уже в БД,
  // brief.md рендерится в approve-callback. Юрий получит пакет и сделает
  // карусель вручную через Claude Design.
  try {
    await notifyApprovalReady(
      { contentPackageId: content_package_id },
      { pool: deps.pool },
    );
  } catch (err) {
    log.warn(
      { contentPackageId: content_package_id, err: (err as Error).message },
      'carousel-worker: notifyApprovalReady failed (non-fatal)',
    );
  }

  // Если рендер упал — НЕ throw (иначе бесконечный retry в BullMQ).
  // Возвращаем error-статус, BullMQ счистит job по defaultJobOptions.
  if (renderErr) {
    return {
      status: 'error',
      contentPackageId: content_package_id,
      reason: renderErr.message.slice(0, 200),
    };
  }

  return {
    status: 'ok',
    contentPackageId: renderRes!.contentPackageId,
    slidesRendered: renderRes!.slides.length,
    totalDurationMs: renderRes!.totalDurationMs,
  };
}
