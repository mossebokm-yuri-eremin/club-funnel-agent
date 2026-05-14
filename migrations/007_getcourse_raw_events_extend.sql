-- ============================================================================
-- migrations/007_getcourse_raw_events_extend.sql
-- Расширяем 006 под GetCourse GET+POST формат (см. изменение архитектуры от Юрия 2026-05-14).
--
-- GetCourse по умолчанию шлёт GET с query-string (а не POST с JSON).
-- Поэтому нам нужно различать метод и хранить query/body отдельно.
-- ============================================================================

ALTER TABLE getcourse_raw_events
  ADD COLUMN IF NOT EXISTS request_method     TEXT,
  ADD COLUMN IF NOT EXISTS request_path       TEXT,
  ADD COLUMN IF NOT EXISTS query_params       JSONB,
  ADD COLUMN IF NOT EXISTS body_raw           TEXT,
  ADD COLUMN IF NOT EXISTS body_parsed        JSONB,
  ADD COLUMN IF NOT EXISTS user_agent         TEXT,
  ADD COLUMN IF NOT EXISTS parsed_order_id    TEXT;

-- Старая колонка raw_payload (из 006) теперь legacy: парсер всё равно её читает,
-- но новые записи кладут query_params/body_parsed. raw_payload оставляем для
-- совместимости — INSERT по-старому пути будет писать туда же.
ALTER TABLE getcourse_raw_events
  ALTER COLUMN raw_payload DROP NOT NULL;

-- Backfill: пометим существующие записи как POST (раньше принимали только POST).
UPDATE getcourse_raw_events
   SET request_method = 'POST',
       request_path = '/webhook/getcourse',
       body_parsed = raw_payload
 WHERE request_method IS NULL;

-- Индексы под новые поля.
CREATE INDEX IF NOT EXISTS idx_gc_raw_order ON getcourse_raw_events (parsed_order_id);
