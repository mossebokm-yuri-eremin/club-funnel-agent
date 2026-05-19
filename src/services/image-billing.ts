// image-billing — INSERT в image_generations + агрегация для /admin/billing.
//
// Используется carousel-renderer'ом после каждого generateGptunnelImage
// (или иной AI-генерации картинок).

import type { Pool } from 'pg';
import { log } from '../observability/logger.js';

export type ImageProvider = 'gptunnel' | 'gemini' | 'replicate';
export type ImageGenStatus = 'ok' | 'error';

export interface RecordImageGenInput {
  contentPackageId?: string;
  slideNumber?: number;
  model: string;
  provider: ImageProvider;
  prompt: string;
  imageUrlExternal?: string;
  imageUrlLocal?: string;
  generationId?: string;
  costKopecks: number;
  durationMs?: number;
  bytes?: number;
  painTag?: string;
  status?: ImageGenStatus;
  errorMessage?: string;
}

/**
 * Записывает одну генерацию в image_generations. Best-effort:
 * если запись не удалась — пишем error в логи, но не пробрасываем
 * наверх (генерация картинки — главное, биллинг — вторичный).
 */
export async function recordImageGeneration(
  pool: Pool,
  input: RecordImageGenInput,
): Promise<{ id: number } | null> {
  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO image_generations
         (content_package_id, slide_number, model, provider, prompt,
          image_url_external, image_url_local, generation_id,
          cost_kopecks, duration_ms, bytes, pain_tag, status, error_message)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        input.contentPackageId ?? null,
        input.slideNumber ?? null,
        input.model,
        input.provider,
        input.prompt.slice(0, 8000), // защита от слишком длинных промптов
        input.imageUrlExternal ?? null,
        input.imageUrlLocal ?? null,
        input.generationId ?? null,
        input.costKopecks,
        input.durationMs ?? null,
        input.bytes ?? null,
        input.painTag ?? null,
        input.status ?? 'ok',
        input.errorMessage ?? null,
      ],
    );
    return { id: r.rows[0]!.id };
  } catch (err) {
    log.error(
      {
        err: (err as Error).message,
        model: input.model,
        provider: input.provider,
        costKopecks: input.costKopecks,
      },
      'image-billing: insert failed (non-fatal)',
    );
    return null;
  }
}

// --- Aggregations для /admin/billing ----------------------------------------

export type BillingPeriod = 'today' | 'week' | 'month';

function periodToInterval(period: BillingPeriod): string {
  switch (period) {
    case 'week':
      return '7 days';
    case 'month':
      return '30 days';
    case 'today':
    default:
      return '1 day';
  }
}

export interface BillingByModel {
  model: string;
  provider: string;
  count_total: number;
  count_ok: number;
  count_error: number;
  total_kopecks: number;
  total_rub: number;
  avg_duration_ms: number;
}

export interface BillingByPain {
  pain_tag: string | null;
  count: number;
  total_kopecks: number;
  total_rub: number;
}

export interface BillingSummary {
  period: BillingPeriod;
  since: string;
  totals: {
    count_total: number;
    count_ok: number;
    count_error: number;
    total_kopecks: number;
    total_rub: number;
  };
  by_model: BillingByModel[];
  by_pain: BillingByPain[];
}

/** Общий summary за период (today / week / month). */
export async function getBillingSummary(
  pool: Pool,
  period: BillingPeriod = 'today',
): Promise<BillingSummary> {
  const interval = periodToInterval(period);

  const totalsRes = await pool.query<{
    count_total: string;
    count_ok: string;
    count_error: string;
    total_kopecks: string;
  }>(
    `SELECT
        COUNT(*)::text AS count_total,
        COUNT(*) FILTER (WHERE status = 'ok')::text AS count_ok,
        COUNT(*) FILTER (WHERE status = 'error')::text AS count_error,
        COALESCE(SUM(cost_kopecks) FILTER (WHERE status = 'ok'), 0)::text AS total_kopecks
       FROM image_generations
      WHERE created_at >= NOW() - $1::interval`,
    [interval],
  );

  const totalKop = Number(totalsRes.rows[0]?.total_kopecks ?? '0');

  const byModelRes = await pool.query<{
    model: string;
    provider: string;
    count_total: string;
    count_ok: string;
    count_error: string;
    total_kopecks: string;
    avg_duration_ms: string;
  }>(
    `SELECT model, provider,
            COUNT(*)::text AS count_total,
            COUNT(*) FILTER (WHERE status = 'ok')::text AS count_ok,
            COUNT(*) FILTER (WHERE status = 'error')::text AS count_error,
            COALESCE(SUM(cost_kopecks) FILTER (WHERE status = 'ok'), 0)::text AS total_kopecks,
            COALESCE(AVG(duration_ms) FILTER (WHERE status = 'ok'), 0)::text AS avg_duration_ms
       FROM image_generations
      WHERE created_at >= NOW() - $1::interval
      GROUP BY model, provider
      ORDER BY SUM(cost_kopecks) DESC NULLS LAST`,
    [interval],
  );

  const byPainRes = await pool.query<{
    pain_tag: string | null;
    count: string;
    total_kopecks: string;
  }>(
    `SELECT pain_tag,
            COUNT(*)::text AS count,
            COALESCE(SUM(cost_kopecks), 0)::text AS total_kopecks
       FROM image_generations
      WHERE created_at >= NOW() - $1::interval
        AND status = 'ok'
      GROUP BY pain_tag
      ORDER BY SUM(cost_kopecks) DESC NULLS LAST
      LIMIT 20`,
    [interval],
  );

  return {
    period,
    since: new Date(Date.now() - parseIntervalMs(interval)).toISOString(),
    totals: {
      count_total: Number(totalsRes.rows[0]?.count_total ?? '0'),
      count_ok: Number(totalsRes.rows[0]?.count_ok ?? '0'),
      count_error: Number(totalsRes.rows[0]?.count_error ?? '0'),
      total_kopecks: totalKop,
      total_rub: Number((totalKop / 100).toFixed(2)),
    },
    by_model: byModelRes.rows.map((r) => {
      const k = Number(r.total_kopecks);
      return {
        model: r.model,
        provider: r.provider,
        count_total: Number(r.count_total),
        count_ok: Number(r.count_ok),
        count_error: Number(r.count_error),
        total_kopecks: k,
        total_rub: Number((k / 100).toFixed(2)),
        avg_duration_ms: Math.round(Number(r.avg_duration_ms)),
      };
    }),
    by_pain: byPainRes.rows.map((r) => {
      const k = Number(r.total_kopecks);
      return {
        pain_tag: r.pain_tag,
        count: Number(r.count),
        total_kopecks: k,
        total_rub: Number((k / 100).toFixed(2)),
      };
    }),
  };
}

function parseIntervalMs(interval: string): number {
  if (interval.includes('day')) {
    const n = parseInt(interval, 10);
    return n * 24 * 3600_000;
  }
  return 24 * 3600_000;
}

/**
 * Суточный расход (для billing-alert-worker). Возвращает сумму в копейках
 * за последние 24h по успешным генерациям.
 */
export async function dailyCostKopecks(pool: Pool): Promise<number> {
  const r = await pool.query<{ sum: string }>(
    `SELECT COALESCE(SUM(cost_kopecks), 0)::text AS sum
       FROM image_generations
      WHERE status = 'ok'
        AND created_at >= NOW() - INTERVAL '24 hours'`,
  );
  return Number(r.rows[0]?.sum ?? '0');
}
