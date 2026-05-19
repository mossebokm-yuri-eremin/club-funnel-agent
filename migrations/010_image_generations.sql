-- ============================================================================
-- migrations/010_image_generations.sql
-- Логирование стоимости AI-генераций (БЛОК D Phase 8).
--
-- Каждая генерация картинки через любой AI-провайдер (GPTunnel seedream-4,
-- Nano Banana, Replicate в будущем) → одна строка здесь.
-- Это вход для:
--   • /admin/billing (today/week/month разбивка по моделям + content type)
--   • billing-alert-worker (TG-алерт если суточный расход > 500₽)
--   • аудита расходов на content_package level
--
-- Деньги — в копейках (BIGINT). CLAUDE.md §4 sacred: никакого float/numeric.
-- ============================================================================

CREATE TABLE IF NOT EXISTS image_generations (
  id                    BIGSERIAL    PRIMARY KEY,
  -- FK на content_packages, NULL если генерация была вне контекста (smoke / test).
  content_package_id    UUID         REFERENCES content_packages(id),
  -- Номер слайда внутри carousel (1..N), NULL если cover лонгрида / smoke.
  slide_number          INTEGER,
  -- 'seedream-4' / 'flux-ultra' / 'imagine-3' / 'gemini-2.5-flash-image'.
  model                 TEXT         NOT NULL,
  -- 'gptunnel' / 'gemini' / 'replicate'.
  provider              TEXT         NOT NULL DEFAULT 'gptunnel',
  -- Полный промпт (для аудита + future fine-tuning).
  prompt                TEXT         NOT NULL,
  -- URL у провайдера (живёт ~24h у Seedream — потом исчезнет).
  image_url_external    TEXT,
  -- Наш URL после загрузки на CDN (cloudinary или local).
  image_url_local       TEXT,
  -- ID на стороне провайдера (для billing reconcile).
  generation_id         TEXT,
  -- Стоимость в копейках. 8₽ Seedream = 800. CLAUDE.md §4.
  cost_kopecks          BIGINT       NOT NULL DEFAULT 0,
  -- Сколько шла генерация (timing для алертов на slowdown).
  duration_ms           INTEGER,
  -- Размер картинки (NULL если не скачали).
  bytes                 BIGINT,
  -- Для группировки в /admin/billing по болям ЦА.
  pain_tag              TEXT,
  -- Финальный статус: 'ok' = успех, 'error' = провайдер вернул ошибку.
  status                TEXT         NOT NULL DEFAULT 'ok'
                                     CHECK (status IN ('ok', 'error')),
  error_message         TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS imggen_created_idx ON image_generations (created_at DESC);
CREATE INDEX IF NOT EXISTS imggen_pkg_idx     ON image_generations (content_package_id);
CREATE INDEX IF NOT EXISTS imggen_model_idx   ON image_generations (model, created_at DESC);
-- Для суточного расхода — частичный индекс на 'ok'.
CREATE INDEX IF NOT EXISTS imggen_billing_idx
  ON image_generations (created_at DESC)
  WHERE status = 'ok';

GRANT SELECT, INSERT, UPDATE ON image_generations TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE image_generations_id_seq TO app_runtime;
