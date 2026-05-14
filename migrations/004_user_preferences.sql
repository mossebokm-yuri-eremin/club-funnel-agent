-- ============================================================================
-- migrations/004_user_preferences.sql
-- Phase 7: пользовательские предпочтения по содержанию контента.
--
-- Юрий командой /style <short|normal|detailed> переключает длину текстов:
--   short    — TG 150–250 слов, Reels 60–100, слайды 1 предложение
--   normal   — TG 300–500 слов
--   detailed — TG 500–800 слов
-- По умолчанию short (запрос Юрия — посты слишком длинные).
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_preferences (
  tg_user_id     BIGINT      PRIMARY KEY,
  content_style  TEXT        NOT NULL DEFAULT 'short'
                              CHECK (content_style IN ('short', 'normal', 'detailed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Никаких REVOKE — это простая user-preferences таблица, не ПД.
GRANT SELECT, INSERT, UPDATE ON user_preferences TO app_runtime;
