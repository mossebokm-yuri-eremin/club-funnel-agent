-- ============================================================================
-- 016_getcourse_raw_events_utm.sql
-- UTM-колонки в getcourse_raw_events для быстрой атрибуции воронок
-- (источник: ТЗ ye-ambassador-bot 2026-06-08).
-- ============================================================================

ALTER TABLE getcourse_raw_events
  ADD COLUMN IF NOT EXISTS utm_source   TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS utm_content  TEXT;

-- Индексы под фильтр воронки + атрибуцию.
CREATE INDEX IF NOT EXISTS idx_gc_raw_utm_source
  ON getcourse_raw_events (utm_source)
  WHERE utm_source IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gc_raw_utm_campaign
  ON getcourse_raw_events (utm_campaign)
  WHERE utm_campaign IS NOT NULL;

-- Backfill: вытащим UTM из body_parsed/query_params для существующих записей.
UPDATE getcourse_raw_events
   SET utm_source   = COALESCE(body_parsed->>'utm_source',   query_params->>'utm_source'),
       utm_campaign = COALESCE(body_parsed->>'utm_campaign', query_params->>'utm_campaign'),
       utm_content  = COALESCE(body_parsed->>'utm_content',  query_params->>'utm_content')
 WHERE (utm_source IS NULL AND utm_campaign IS NULL AND utm_content IS NULL)
   AND (body_parsed IS NOT NULL OR query_params IS NOT NULL);
