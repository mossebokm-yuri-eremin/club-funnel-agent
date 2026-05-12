// Analytics — SPEC §2.11 (AC-31..AC-33). Все запросы — против БД, без LLM.
// Деньги — BIGINT копеек (CLAUDE.md §4).

import type { Pool } from 'pg';

export interface DailyMetricsRow {
  day: string; // YYYY-MM-DD
  ig_comments: number;
  directs: number;
  pdfs_delivered: number;
  club_paid: number;
  revenue_kopecks: number;
  /** CR Direct = pdfs_delivered / directs (0..1) */
  ctr_direct: number;
  /** Конверсия в клуб = club_paid / pdfs_delivered (0..1) */
  club_conversion: number;
}

export interface FunnelConversionStage {
  stage: string;
  events: number;
  cr_from_prev: number | null; // null для первого этапа
}

export interface ClubRetentionRow {
  cohort_month: string; // YYYY-MM
  cohort_size: number;
  retained_month_1: number;
  retained_month_3: number;
  retained_month_6: number;
}

// ---------------------------------------------------------------------------

export async function dailyMetrics(
  pool: Pool,
  options: { days?: number } = {},
): Promise<DailyMetricsRow[]> {
  const days = Math.max(1, Math.min(90, options.days ?? 30));
  const r = await pool.query<{
    day: string;
    ig_comments: string | number;
    directs: string | number;
    pdfs_delivered: string | number;
    club_paid: string | number;
    revenue_kopecks: string | number;
  }>(
    `SELECT day::text AS day,
            ig_comments, directs, pdfs_delivered, club_paid, revenue_kopecks
       FROM v_funnel_daily_metrics
      WHERE day >= (NOW() - ($1::int || ' days')::interval)::date
      ORDER BY day DESC`,
    [days],
  );
  return r.rows.map((row): DailyMetricsRow => {
    const directs = Number(row.directs);
    const pdfs = Number(row.pdfs_delivered);
    const club = Number(row.club_paid);
    return {
      day: row.day,
      ig_comments: Number(row.ig_comments),
      directs,
      pdfs_delivered: pdfs,
      club_paid: club,
      revenue_kopecks: Number(row.revenue_kopecks),
      ctr_direct: directs > 0 ? Number((pdfs / directs).toFixed(4)) : 0,
      club_conversion: pdfs > 0 ? Number((club / pdfs).toFixed(4)) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Сквозная воронка по этапам (агрегированно за период). Этапы фиксированы.
// ---------------------------------------------------------------------------

const FUNNEL_STAGES: readonly FunnelEventCodeStage[] = [
  { stage: 'ig_comment', event_type: 'ig_comment' },
  { stage: 'direct_received', event_type: 'direct_received' },
  { stage: 'pdf_delivered', event_type: 'pdf_delivered' },
  { stage: 'club_offered', event_type: 'club_offered' },
  { stage: 'club_purchased', event_type: 'club_purchased' },
] as const;

interface FunnelEventCodeStage {
  stage: string;
  event_type: string;
}

export async function funnelConversionByStage(
  pool: Pool,
  options: { days?: number; codeWord?: string } = {},
): Promise<FunnelConversionStage[]> {
  const days = Math.max(1, Math.min(180, options.days ?? 30));
  const params: unknown[] = [days];
  let cwFilter = '';
  if (options.codeWord) {
    params.push(options.codeWord);
    cwFilter = ` AND code_word = $${params.length}`;
  }
  const r = await pool.query<{ event_type: string; n: string | number }>(
    `SELECT event_type, COUNT(*)::int AS n
       FROM funnel_events
      WHERE deleted_at IS NULL
        AND occurred_at >= NOW() - ($1::int || ' days')::interval
        ${cwFilter}
      GROUP BY event_type`,
    params,
  );
  const counts = new Map<string, number>();
  for (const row of r.rows) counts.set(row.event_type, Number(row.n));

  const stages: FunnelConversionStage[] = [];
  let prev: number | null = null;
  for (const s of FUNNEL_STAGES) {
    const n = counts.get(s.event_type) ?? 0;
    const cr = prev === null ? null : prev > 0 ? Number((n / prev).toFixed(4)) : 0;
    stages.push({ stage: s.stage, events: n, cr_from_prev: cr });
    prev = n;
  }
  return stages;
}

// ---------------------------------------------------------------------------
// Удержание клуба: cohort retention по subscribers.club_paid_at.
// Возвращает по месяцам: размер когорты, активные через 1/3/6 месяцев
// (активность = payments в окне cohort_month+N±15d).
// ---------------------------------------------------------------------------

export async function clubRetentionByCohort(pool: Pool): Promise<ClubRetentionRow[]> {
  const r = await pool.query<{
    cohort_month: string;
    cohort_size: string | number;
    retained_month_1: string | number;
    retained_month_3: string | number;
    retained_month_6: string | number;
  }>(
    `WITH cohorts AS (
       SELECT date_trunc('month', s.club_paid_at)::date AS cohort_month, s.id
         FROM subscribers s
        WHERE s.club_paid_at IS NOT NULL AND s.deleted_at IS NULL
     ),
     retention AS (
       SELECT c.cohort_month,
              COUNT(DISTINCT c.id)::int AS cohort_size,
              COUNT(DISTINCT CASE
                WHEN p.paid_at::date BETWEEN (c.cohort_month + INTERVAL '15 days')::date
                                         AND (c.cohort_month + INTERVAL '45 days')::date
                THEN c.id END)::int AS retained_month_1,
              COUNT(DISTINCT CASE
                WHEN p.paid_at::date BETWEEN (c.cohort_month + INTERVAL '75 days')::date
                                         AND (c.cohort_month + INTERVAL '105 days')::date
                THEN c.id END)::int AS retained_month_3,
              COUNT(DISTINCT CASE
                WHEN p.paid_at::date BETWEEN (c.cohort_month + INTERVAL '165 days')::date
                                         AND (c.cohort_month + INTERVAL '195 days')::date
                THEN c.id END)::int AS retained_month_6
         FROM cohorts c
    LEFT JOIN payments p ON p.subscriber_id = c.id
        GROUP BY c.cohort_month
     )
     SELECT to_char(cohort_month, 'YYYY-MM') AS cohort_month,
            cohort_size, retained_month_1, retained_month_3, retained_month_6
       FROM retention
      ORDER BY cohort_month DESC
      LIMIT 24`,
  );
  return r.rows.map((row) => ({
    cohort_month: row.cohort_month,
    cohort_size: Number(row.cohort_size),
    retained_month_1: Number(row.retained_month_1),
    retained_month_3: Number(row.retained_month_3),
    retained_month_6: Number(row.retained_month_6),
  }));
}
