-- ============================================================================
-- migrations/011_carousel_template_usage.sql
-- Tracking использования эталонных каруселей из GDrive для style-transfer
-- через Seedream (Phase 9 carousel style refactor).
--
-- Логика: при генерации новой карусели агент:
--   1. Определяет тему (regex + Haiku fallback)
--   2. Выбирает эталонную карусель из GDrive (`04-carousel-templates-ye/carousel-NN-XXX`)
--   3. Берёт 2-3 слайда как style reference для Seedream `images[]`
--   4. Логирует факт использования сюда → потом аналитика какие шаблоны
--      работают лучше (по approval rate)
-- ============================================================================

CREATE TABLE IF NOT EXISTS carousel_template_usage (
  id                    BIGSERIAL    PRIMARY KEY,
  content_package_id    UUID         REFERENCES content_packages(id),
  voice_code            TEXT         CHECK (voice_code IN ('YE', 'RZ')),
  -- 'money' | 'errors' | 'AI' | 'prompt' | 'phrase' | 'expert' | 'color' | 'brand' | 'designers' | 'fallback'
  theme                 TEXT         NOT NULL,
  -- Имя папки эталона: 'carousel-03-money' / 'carousel-01-designers' etc.
  template_folder       TEXT         NOT NULL,
  -- Drive file_id'ы реально использованных reference-слайдов (cover, body, cta).
  reference_slide_ids   TEXT[]       NOT NULL DEFAULT '{}',
  -- True если тема определена через Haiku (не regex). Для аналитики precision.
  classified_by_llm     BOOLEAN      NOT NULL DEFAULT false,
  -- Сырая выдача классификатора (для debug, если LLM ответил что-то странное).
  classifier_raw        TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ctu_pkg_idx     ON carousel_template_usage (content_package_id);
CREATE INDEX IF NOT EXISTS ctu_theme_idx   ON carousel_template_usage (theme, created_at DESC);
CREATE INDEX IF NOT EXISTS ctu_created_idx ON carousel_template_usage (created_at DESC);

GRANT SELECT, INSERT, UPDATE ON carousel_template_usage TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE carousel_template_usage_id_seq TO app_runtime;
