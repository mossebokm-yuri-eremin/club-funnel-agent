-- ============================================================================
-- migrations/013_ig_publications.sql
-- Журнал опубликованных постов в Instagram (через ручную публикацию Юрием).
--
-- Логика: после approve content_package и активации воронки агент шлёт Юрию
-- инструкцию + IG caption + code_word. Юрий публикует пост в IG ручками,
-- затем шлёт боту `/published <url>` — мы запишем строку сюда.
-- Используется для:
--  - аналитики (сколько каруселей реально опубликовано)
--  - связки funnel ↔ ig_post (для будущего мониторинга комментов)
-- ============================================================================

CREATE TABLE IF NOT EXISTS ig_publications (
  id                    BIGSERIAL    PRIMARY KEY,
  idea_id               UUID         REFERENCES ideas(id),
  content_package_id    UUID         REFERENCES content_packages(id),
  funnel_id             UUID         REFERENCES funnels(id),
  post_url              TEXT         NOT NULL,
  ig_shortcode          TEXT,
  caption               TEXT,
  code_word             TEXT,
  published_by_tg_user  BIGINT,
  published_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS igp_idea_idx     ON ig_publications (idea_id);
CREATE INDEX IF NOT EXISTS igp_funnel_idx   ON ig_publications (funnel_id);
CREATE INDEX IF NOT EXISTS igp_code_idx     ON ig_publications (code_word);
CREATE UNIQUE INDEX IF NOT EXISTS igp_shortcode_uq ON ig_publications (ig_shortcode) WHERE ig_shortcode IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON ig_publications TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE ig_publications_id_seq TO app_runtime;
