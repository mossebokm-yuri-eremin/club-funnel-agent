-- ============================================================================
-- migrations/014_yury_voice_samples.sql
-- Извлечённые тексты реальных постов Юрия (из 08-yuri-past-posts/).
-- Используются для:
--   1) обучения нового twin-ye промпта (анализ стиля)
--   2) ретривала живых примеров через embeddings при генерации
-- ============================================================================

CREATE TABLE IF NOT EXISTS yury_voice_samples (
  id            BIGSERIAL    PRIMARY KEY,
  source_file   TEXT         NOT NULL UNIQUE,
  drive_file_id TEXT,
  full_text     TEXT         NOT NULL,
  length_chars  INTEGER      NOT NULL,
  embedding     vector(1536),
  extracted_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS yvs_emb_cos_idx
  ON yury_voice_samples USING ivfflat (embedding vector_cosine_ops) WITH (lists = 4);

GRANT SELECT, INSERT, UPDATE, DELETE ON yury_voice_samples TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE yury_voice_samples_id_seq TO app_runtime;
