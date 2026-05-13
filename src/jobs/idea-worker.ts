// Воркер 'idea_queue': принимает ideaId, читает ideas.raw_transcript, прогоняет
// через idea-builder (LLM-structuring), фиксирует pain_tag/summary.
// После успеха — enqueue в content_queue (если caller это включил).

import { Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES, type IdeaJobData, contentQueue } from './queues.js';
import { buildIdea } from '../services/idea-builder.js';

export interface IdeaWorkerDeps {
  pool: Pool;
  concurrency?: number;
  /** Передавать ли результат в content_queue. По умолчанию — да. */
  enqueueContent?: boolean;
}

export interface IdeaWorkerResult {
  status: 'ok' | 'skipped' | 'error';
  ideaId: string;
  reason?: string;
}

export function createIdeaWorker(deps: IdeaWorkerDeps): Worker<IdeaJobData, IdeaWorkerResult> {
  const worker = new Worker<IdeaJobData, IdeaWorkerResult>(
    QUEUE_NAMES.IDEA,
    async (job) => process(job, deps),
    {
      connection: createRedisClient(),
      concurrency: deps.concurrency ?? 2,
    },
  );
  worker.on('ready', () => {
    log.info({ queue: QUEUE_NAMES.IDEA }, 'idea-worker: READY listening');
  });
  worker.on('active', (job) => {
    log.info({ jobId: job.id, ideaId: job.data.idea_id }, 'idea-worker: ACTIVE start');
  });

  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, queue: QUEUE_NAMES.IDEA, err: err.message },
      'idea-worker: job failed',
    );
  });
  worker.on('completed', (job, result) => {
    log.info(
      { jobId: job.id, queue: QUEUE_NAMES.IDEA, status: result.status, ideaId: result.ideaId },
      'idea-worker: job completed',
    );
  });

  return worker;
}

async function process(
  job: Job<IdeaJobData>,
  deps: IdeaWorkerDeps,
): Promise<IdeaWorkerResult> {
  const { idea_id } = job.data;
  const row = await deps.pool.query<{
    id: string;
    source: 'voice' | 'text' | 'reference_adapt';
    raw_transcript: string | null;
    angle_transcript: string | null;
    status: string;
  }>(
    `SELECT id, source, raw_transcript, angle_transcript, status FROM ideas WHERE id = $1`,
    [idea_id],
  );
  const idea = row.rows[0];
  if (!idea) {
    return { status: 'skipped', ideaId: idea_id, reason: 'idea not found' };
  }
  if (idea.status !== 'new') {
    return { status: 'skipped', ideaId: idea_id, reason: `status=${idea.status}` };
  }
  const rawText = idea.source === 'reference_adapt' ? idea.angle_transcript : idea.raw_transcript;
  if (!rawText || !rawText.trim()) {
    return { status: 'skipped', ideaId: idea_id, reason: 'no transcript' };
  }

  await buildIdea(
    {
      ideaId: idea.id,
      rawText,
      source: idea.source,
    },
    { pool: deps.pool },
  );

  if (deps.enqueueContent !== false) {
    await contentQueue().add('generate', { idea_id: idea.id });
  }
  return { status: 'ok', ideaId: idea.id };
}
