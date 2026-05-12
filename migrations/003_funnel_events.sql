-- ============================================================================
-- migrations/003_funnel_events.sql
-- Phase 4: воронка + аналитика (SPEC §2.10–2.11)
--
-- CLAUDE.md §1 (sacred): единственный CTA — клуб «Реализация». Никаких
-- промежуточных платных SKU (tripwire/loss-leader/курсы/наставничество).
--
-- Изменения:
--   1) funnel_events: добавляем deleted_at (152-ФЗ soft-delete) + индекс «живых».
--      Hard delete у app_runtime отзывается через REVOKE.
--   2) subscribers: добавляем колонку club_paid_at — для cohort retention по клубу.
--      Деньги нигде не храним — суммы берём из payments.amount_kopecks
--      (INTEGER, как требует CLAUDE.md §4).
--   3) View v_funnel_daily_metrics — ежедневная сводка для analytics.dailyMetrics().
-- ============================================================================

-- --- 1) funnel_events: soft-delete -------------------------------------------
ALTER TABLE funnel_events
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS fe_alive_idx
  ON funnel_events (event_type, occurred_at DESC)
  WHERE deleted_at IS NULL;

-- Отзываем DELETE у app_runtime (152-ФЗ: только soft-delete).
REVOKE DELETE ON funnel_events FROM app_runtime;

-- --- 2) subscribers: метка оплаты клуба для аналитики ------------------------
ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS club_paid_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sub_club_paid_idx
  ON subscribers (club_paid_at DESC)
  WHERE club_paid_at IS NOT NULL AND deleted_at IS NULL;

-- --- 3) daily metrics view ---------------------------------------------------
-- Используется analytics.dailyMetrics(). Считаем CTR Direct и конверсию в клуб
-- за календарные сутки UTC.
CREATE OR REPLACE VIEW v_funnel_daily_metrics AS
SELECT
  d::date AS day,
  -- CTR Direct: directs / показов рилс. Пока показов нет — используем долю от ig_comments.
  COUNT(*) FILTER (
    WHERE fe.event_type = 'ig_comment' AND fe.occurred_at::date = d::date
  ) AS ig_comments,
  COUNT(*) FILTER (
    WHERE fe.event_type = 'direct_received' AND fe.occurred_at::date = d::date
  ) AS directs,
  COUNT(*) FILTER (
    WHERE fe.event_type = 'pdf_delivered' AND fe.occurred_at::date = d::date
  ) AS pdfs_delivered,
  COUNT(*) FILTER (
    WHERE fe.event_type = 'club_purchased' AND fe.occurred_at::date = d::date
  ) AS club_paid,
  COALESCE(SUM(p.amount_kopecks) FILTER (WHERE p.paid_at::date = d::date), 0)::BIGINT AS revenue_kopecks
FROM
  generate_series(
    (NOW() - INTERVAL '90 days')::date,
    NOW()::date,
    '1 day'::interval
  ) AS d
LEFT JOIN funnel_events fe ON fe.occurred_at::date = d::date AND fe.deleted_at IS NULL
LEFT JOIN payments p       ON p.paid_at::date = d::date
GROUP BY d
ORDER BY d DESC;

-- ============================================================================
-- Migration bookkeeping
-- ============================================================================
INSERT INTO _schema_migrations (version) VALUES ('003_funnel_events')
  ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- КОНЕЦ 003_funnel_events.sql
-- ============================================================================
