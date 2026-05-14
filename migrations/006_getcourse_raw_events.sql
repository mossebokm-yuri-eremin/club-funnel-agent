-- ============================================================================
-- migrations/006_getcourse_raw_events.sql
-- Raw-events буфер для GetCourse webhook'ов (Phase 7+).
--
-- ЛОГИКА: webhook ВСЕГДА сохраняет любой пришедший POST в эту таблицу и
-- возвращает 200 OK, чтобы не зависеть от GC retry-логики (GC ответ
-- сервера не парсит — нам нет смысла отдавать что-то кроме 200).
-- Парсер (getcourse-parser-worker) раз в 10 секунд берёт parse_status='pending'
-- и нормализует raw_payload в нужные поля + создаёт/обновляет subscribers.
--
-- Деньги хранятся в копейках (CLAUDE.md §4 — никаких float).
-- ============================================================================

CREATE TABLE IF NOT EXISTS getcourse_raw_events (
  id                     BIGSERIAL    PRIMARY KEY,
  received_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  raw_payload            JSONB        NOT NULL,
  headers                JSONB,
  ip_address             TEXT,
  hmac_valid             BOOLEAN,        -- true=прошёл, false=не прошёл, NULL=не присылали header
  content_type           TEXT,
  parse_status           TEXT         NOT NULL DEFAULT 'pending'
                                       CHECK (parse_status IN ('pending', 'parsed', 'error', 'ignored')),
  parse_error            TEXT,
  parsed_event_type      TEXT,
  parsed_user_email      TEXT,
  parsed_amount_kopecks  BIGINT,
  parsed_at              TIMESTAMPTZ,
  notified_at            TIMESTAMPTZ      -- когда отправили Telegram-уведомление Юрию
);

CREATE INDEX IF NOT EXISTS idx_gc_raw_received ON getcourse_raw_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_gc_raw_status   ON getcourse_raw_events (parse_status, received_at);
CREATE INDEX IF NOT EXISTS idx_gc_raw_email    ON getcourse_raw_events (parsed_user_email);

-- Никаких REVOKE DELETE: при оплате не ПД, технические события.
-- Чистим через retention (90 дней) — отдельной задачей в /admin или cron.
GRANT SELECT, INSERT, UPDATE ON getcourse_raw_events TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE getcourse_raw_events_id_seq TO app_runtime;
