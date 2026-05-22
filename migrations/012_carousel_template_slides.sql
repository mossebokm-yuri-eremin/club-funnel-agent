-- ============================================================================
-- migrations/012_carousel_template_slides.sql
-- Локальный кэш эталонных слайдов из GDrive 04-carousel-templates-ye / 05-rz.
--
-- Зачем: GPTunnel.editImage(images=[URL]) принимает ТОЛЬКО публичные URL.
-- template-sync скачивает слайды раз в день, кладёт в /var/www/cdn/templates/,
-- nginx раздаёт через https://agent.yury-eremin.ru/cdn/templates/<carousel>/<slide>
-- → этот URL мы передаём в nano-banana-2 как base image.
-- ============================================================================

CREATE TABLE IF NOT EXISTS carousel_template_slides (
  id             BIGSERIAL    PRIMARY KEY,
  voice          TEXT         NOT NULL CHECK (voice IN ('ye', 'rz')),
  carousel_name  TEXT         NOT NULL,
  slide_number   INTEGER      NOT NULL,
  drive_file_id  TEXT         NOT NULL,
  drive_filename TEXT         NOT NULL,
  local_path     TEXT         NOT NULL,
  public_url     TEXT         NOT NULL,
  bytes          BIGINT,
  mime_type      TEXT,
  synced_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(voice, carousel_name, slide_number)
);

CREATE INDEX IF NOT EXISTS cts_voice_carousel_idx
  ON carousel_template_slides (voice, carousel_name, slide_number);

GRANT SELECT, INSERT, UPDATE, DELETE ON carousel_template_slides TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE carousel_template_slides_id_seq TO app_runtime;
