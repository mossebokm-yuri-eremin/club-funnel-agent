-- ============================================================================
-- migrations/008_knowledge_embeddings.sql
-- Кэш эмбеддингов knowledge base (rz-funnel-content/*.md).
--
-- Логика:
--   • Файлы knowledge/rz-funnel-content/*.md режутся на чанки (~ по H2 секциям).
--   • Каждый чанк → embedding через OpenAI text-embedding-3-small (1536 dim).
--   • content-gen перед генерацией делает семантический поиск (cosine на pgvector)
--     по теме идеи → топ-3..5 чанков → в промпт как {{kb_excerpts}}.
--   • Команда /refresh_kb в боте пересчитывает все эмбеддинги.
--
-- file_hash хранит SHA-256 текста чанка → не пересчитываем неизменившееся.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id            BIGSERIAL    PRIMARY KEY,
  source_file   TEXT         NOT NULL,
  chunk_index   INTEGER      NOT NULL,
  chunk_text    TEXT         NOT NULL,
  chunk_hash    TEXT         NOT NULL,                -- sha256 от chunk_text
  embedding     vector(1536),                          -- text-embedding-3-small
  token_count   INTEGER,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (source_file, chunk_index)
);

-- pgvector cosine index (ivfflat, lists=8 — у нас ~50-100 чанков, лёгкий)
CREATE INDEX IF NOT EXISTS kb_emb_cos_idx
  ON knowledge_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 8);

CREATE INDEX IF NOT EXISTS kb_source_idx ON knowledge_embeddings (source_file);

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_embeddings TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE knowledge_embeddings_id_seq TO app_runtime;
