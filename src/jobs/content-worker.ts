// Воркер 'content_queue': принимает ideaId (с уже заполненными summary/pain_tag),
// вызывает strategy-chooser (с векторным поиском по bonus_library), затем content-gen
// (с возможной отбраковкой VOICE VALIDATOR), а при стратегии C — longread-factory.
//
// На вход в БД сегодня нет ANN-индекса в проде → векторный поиск делаем здесь по
// упрощённому SQL: cosine distance на pgvector. Если pgvector расширение недоступно
// или таблица пустая — chooser отдаёт C (cold start).

import { Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';
import { QUEUE_NAMES, type ContentJobData, visualQueue } from './queues.js';
import { chooseStrategy, type BonusCandidate, type Strategy } from '../services/strategy-chooser.js';
import { generateContentPackage } from '../services/content-gen.js';
// generateLongread / config будут подключены в Phase 4 (рендер PDF + ChatPlace доставка).

export interface ContentWorkerDeps {
  pool: Pool;
  concurrency?: number;
  /** Функция-генератор кодового слова. По умолчанию — простой uuid-shortener. */
  makeCodeWord?: (ideaId: string) => string;
  /** Источник эмбеддинга для идеи. Возвращает вектор размерности EMBEDDING_DIM. */
  embedIdea?: (summary: string) => Promise<number[] | null>;
}

export interface ContentWorkerResult {
  status: 'ok' | 'escalated' | 'skipped' | 'error';
  ideaId: string;
  strategy?: Strategy;
  contentPackageId?: string;
  bonusId?: string | null;
  reason?: string;
}

const DEFAULT_CODE_WORD = (ideaId: string): string => {
  const short = ideaId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
  return `realiz_${short}`;
};

export function createContentWorker(
  deps: ContentWorkerDeps,
): Worker<ContentJobData, ContentWorkerResult> {
  const worker = new Worker<ContentJobData, ContentWorkerResult>(
    QUEUE_NAMES.CONTENT,
    async (job) => process(job, deps),
    {
      connection: createRedisClient(),
      concurrency: deps.concurrency ?? 1,
    },
  );
  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, queue: QUEUE_NAMES.CONTENT, err: err.message },
      'content-worker: job failed',
    );
  });
  worker.on('completed', (job, result) => {
    log.info(
      { jobId: job.id, queue: QUEUE_NAMES.CONTENT, ...result },
      'content-worker: job completed',
    );
  });
  return worker;
}

interface IdeaRow {
  id: string;
  summary: string | null;
  pain_tag: string | null;
  source: 'voice' | 'text' | 'reference_adapt';
  forced_bonus_id: string | null;
}

async function fetchIdea(pool: Pool, id: string): Promise<IdeaRow | null> {
  const r = await pool.query<IdeaRow>(
    `SELECT id, summary, pain_tag, source, forced_bonus_id FROM ideas WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function fetchTopCandidates(
  pool: Pool,
  embedding: number[] | null,
): Promise<BonusCandidate[]> {
  if (!embedding) return [];
  // Используем cosine distance в pgvector: оператор <=>. similarity = 1 - distance.
  // Берём топ-3 среди status='live' и не soft-deleted.
  const literal = `[${embedding.join(',')}]`;
  const sql = `
    SELECT id, title, 1 - (embedding <=> $1::vector) AS similarity
    FROM bonus_library
    WHERE status = 'live'
      AND deleted_at IS NULL
      AND embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector ASC
    LIMIT 3
  `;
  try {
    const res = await pool.query<{ id: string; title: string; similarity: number }>(sql, [literal]);
    return res.rows.map((r) => ({
      bonusId: r.id,
      title: r.title,
      similarity: Number(r.similarity ?? 0),
    }));
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'content-worker: vector search failed (pgvector?), falling back to []',
    );
    return [];
  }
}

async function countIdeasSinceLastB(pool: Pool): Promise<number> {
  const sql = `
    WITH last_b AS (
      SELECT id, created_at FROM ideas
       WHERE strategy = 'B'
       ORDER BY created_at DESC
       LIMIT 1
    )
    SELECT COUNT(*)::int AS n FROM ideas
     WHERE strategy IS NOT NULL
       AND created_at > COALESCE((SELECT created_at FROM last_b), 'epoch')
  `;
  try {
    const res = await pool.query<{ n: number }>(sql);
    return res.rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

async function process(
  job: Job<ContentJobData>,
  deps: ContentWorkerDeps,
): Promise<ContentWorkerResult> {
  const { idea_id } = job.data;
  const idea = await fetchIdea(deps.pool, idea_id);
  if (!idea) return { status: 'skipped', ideaId: idea_id, reason: 'idea not found' };
  if (!idea.summary || !idea.pain_tag) {
    return { status: 'skipped', ideaId: idea_id, reason: 'summary/pain_tag not set' };
  }

  const codeWord = (deps.makeCodeWord ?? DEFAULT_CODE_WORD)(idea.id);
  const embedding = deps.embedIdea ? await deps.embedIdea(idea.summary) : null;
  const candidates = await fetchTopCandidates(deps.pool, embedding);
  const ideasSinceLastB = await countIdeasSinceLastB(deps.pool);

  const chooserInput = {
    idea: {
      id: idea.id,
      summary: idea.summary,
      painTag: idea.pain_tag,
      source: idea.source,
    },
    topCandidates: candidates,
    ideasSinceLastB,
    ...(idea.forced_bonus_id ? { forcedBonusId: idea.forced_bonus_id } : {}),
  };

  const decision = await chooseStrategy(chooserInput);
  await deps.pool.query(
    `UPDATE ideas SET strategy = $2, strategy_reason = $3, bonus_id = $4, status = 'strategy_chosen' WHERE id = $1`,
    [idea.id, decision.strategy, decision.reasoning, decision.bonusId],
  );

  // Стратегия C → сначала лонгрид, потом контент. A/B → контент сразу.
  const bonusIdForContent: string | null = decision.bonusId;
  let bonusTitle: string | null = null;

  if (decision.strategy === 'C') {
    // Phase 7 AC-16: генерируем OUTLINE и шлём Юрию на согласование.
    // Полный лонгрид пишется ТОЛЬКО после кнопки ✅ в боте.
    const { generateOutline } = await import('../services/outline-generator.js');
    const { notifyOutlineReady } = await import('../services/approval-notifier.js');
    try {
      const { outline } = await generateOutline({
        summary: idea.summary,
        painTag: idea.pain_tag,
      });
      await deps.pool.query(
        `UPDATE ideas
            SET longread_outline = $2::jsonb,
                longread_title   = $3,
                longread_code_word = $4,
                status           = 'longread_outline_pending'
          WHERE id = $1`,
        [
          idea.id,
          JSON.stringify(outline.sections),
          outline.title,
          outline.codeWord,
        ],
      );
      await notifyOutlineReady({ ideaId: idea.id }, { pool: deps.pool });
      log.info({ ideaId: idea.id }, 'content-worker: outline sent for approval (strategy C)');
      return {
        status: 'skipped',
        ideaId: idea.id,
        strategy: 'C',
        reason: 'longread outline sent to Telegram — awaiting Юрий approval',
      };
    } catch (err) {
      log.error(
        { err: (err as Error).message, ideaId: idea.id },
        'content-worker: outline generation failed for strategy C',
      );
      throw err;
    }
  }

  if (decision.bonusId) {
    const row = await deps.pool.query<{ title: string }>(
      `SELECT title FROM bonus_library WHERE id = $1 AND deleted_at IS NULL`,
      [decision.bonusId],
    );
    bonusTitle = row.rows[0]?.title ?? null;
  }

  // Читаем стиль пользователя (/style command — Phase 7, Правка 5).
  // Default — 'short'. tg_user_id берём из config (только YE использует бот).
  const { getUserStyle } = await import('../services/user-preferences.js');
  const { config: cfg } = await import('../config.js');
  const style = await getUserStyle(deps.pool, cfg.YE_TG_USER_ID);

  const pkg = await generateContentPackage(
    {
      ideaId: idea.id,
      summary: idea.summary,
      painTag: idea.pain_tag,
      strategy: decision.strategy,
      bonusTitle,
      codeWord: decision.strategy === 'B' ? null : codeWord,
      style,
    },
    { pool: deps.pool },
  );

  await deps.pool.query(`UPDATE ideas SET status = 'content_ready' WHERE id = $1`, [idea.id]);

  // Enqueue визуализации (SPEC §2.7 AC-19..21). Если voice-validator не прошёл
  // (escalated), карусели всё равно нужно отрендерить — Юрий может одобрить с правками,
  // картинки актуальны для текста, который он утвердит вручную.
  try {
    await visualQueue().add('render', {
      idea_id: idea.id,
      content_package_id: pkg.contentPackageId,
    });
  } catch (err) {
    log.warn(
      { ideaId: idea.id, err: (err as Error).message },
      'content-worker: failed to enqueue visual (continuing)',
    );
  }

  const result: ContentWorkerResult = {
    status: pkg.escalated ? 'escalated' : 'ok',
    ideaId: idea.id,
    strategy: decision.strategy,
    contentPackageId: pkg.contentPackageId,
    bonusId: bonusIdForContent,
  };
  return result;
}

