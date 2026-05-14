-- ============================================================================
-- migrations/005_longread_drafts.sql
-- Phase 7: longread approval flow (AC-16 минимальная версия).
--
-- Поток для стратегии C:
--   strategy_chosen → generate outline → outline_pending_approval
--     (Юрий ✅) → generate full text → draft_pending_approval
--     (Юрий ✅) → INSERT в bonus_library (status='live'), idea → bonus_published
--
-- Используем колонки на самой ideas — отдельная таблица не нужна.
-- ============================================================================

ALTER TABLE ideas
  ADD COLUMN IF NOT EXISTS longread_outline    JSONB,
  ADD COLUMN IF NOT EXISTS longread_draft_md   TEXT,
  ADD COLUMN IF NOT EXISTS longread_title      TEXT,
  ADD COLUMN IF NOT EXISTS longread_code_word  TEXT;

-- Расширяем status check — старые значения остаются работать, добавлены 3 новых.
-- Сначала пробуем удалить старое ограничение, если оно вообще есть (его в schema нет
-- по умолчанию — на ideas.status check-а нет, только default 'new'). Команды
-- идемпотентны: повторный прогон не сломает БД.

-- Дать app_runtime UPDATE — он уже есть, отдельный GRANT не нужен.

-- Индекс для быстрого фильтра «лонгриды в работе».
CREATE INDEX IF NOT EXISTS idea_longread_status_idx
  ON ideas (status, created_at DESC)
  WHERE status IN ('longread_outline_pending', 'longread_draft_pending');

-- bonus_library: pdf_url / pdf_gdrive_id NOT NULL — оставляем как есть.
-- В Phase 7 на этапе INSERT мы кладём placeholder '' (Phase 4 переделает на реальный
-- PDF + GDrive после рендера через Puppeteer).
ALTER TABLE bonus_library
  ALTER COLUMN pdf_url        SET DEFAULT '',
  ALTER COLUMN pdf_gdrive_id  SET DEFAULT '';
