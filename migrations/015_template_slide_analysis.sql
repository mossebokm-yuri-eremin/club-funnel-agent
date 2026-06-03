-- 015_template_slide_analysis — кэш Vision-анализа эталонных слайдов.
--
-- Чтобы не дёргать Sonnet 4.6 Vision при каждом рендере для одних и тех же эталонов,
-- результат анализа (hasPersonFace / faceRole / facePosition / background) кэшируется
-- в этой таблице. Сбрасывается только при ручной инвалидации.
--
-- Используется в carousel-renderer.ts для выбора стратегии замены лица.

CREATE TABLE IF NOT EXISTS template_slide_analysis (
  template_slide_id BIGINT PRIMARY KEY
    REFERENCES carousel_template_slides(id) ON DELETE CASCADE,
  has_person_face BOOLEAN NOT NULL DEFAULT FALSE,
  face_position TEXT,           -- 'center' | 'top' | 'bottom' | 'left' | 'right' | NULL
  face_role TEXT,               -- 'man-40-50' | 'woman-30-40' | 'woman-20-30' | 'multiple-people' | NULL
  is_portrait_focused BOOLEAN NOT NULL DEFAULT FALSE,
  background TEXT,              -- 'studio' | 'outdoor' | 'office' | 'home' | 'abstract' | NULL
  raw_vision_response JSONB,    -- полный ответ модели для дебага
  model_used TEXT NOT NULL,     -- 'claude-sonnet-4-6' / 'claude-haiku-4-5'
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tsa_has_face ON template_slide_analysis(has_person_face);
CREATE INDEX IF NOT EXISTS idx_tsa_face_role ON template_slide_analysis(face_role) WHERE face_role IS NOT NULL;

COMMENT ON TABLE template_slide_analysis IS 'Кэш Vision-анализа эталонных слайдов (Phase 12 face-replacement). См. carousel-renderer.ts';
COMMENT ON COLUMN template_slide_analysis.face_role IS 'man-40-50 → место Юрия. woman-* → героиня (Виктория/кейс). multiple-people → не трогать.';
