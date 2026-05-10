-- ============================================================================
-- migrations/001_initial.sql
-- club-funnel-agent — первичная схема БД
-- PostgreSQL 16 + pgvector
-- Все деньги — BIGINT копеек. Все ID — UUID v7 (генерируются приложением).
-- Все timestamps — TIMESTAMPTZ.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;       -- gen_random_uuid (для безопасных дефолтов)
CREATE EXTENSION IF NOT EXISTS vector;         -- pgvector
CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- триграммный поиск по строкам

-- ----------------------------------------------------------------------------
-- 1) voices — голосовые аватары
-- ----------------------------------------------------------------------------
CREATE TABLE voices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 TEXT NOT NULL UNIQUE,            -- 'YE' | 'RZ'
  display_name         TEXT NOT NULL,
  role                 TEXT NOT NULL,                   -- 'mentor' | 'club_member'
  system_prompt        TEXT NOT NULL,
  required_markers     JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_markers    JSONB NOT NULL DEFAULT '[]'::jsonb,
  example_posts        JSONB NOT NULL DEFAULT '[]'::jsonb,
  voice_portrait_md    TEXT,
  prompt_version       TEXT NOT NULL DEFAULT 'v1',
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 2) prompt_versions — журнал изменений промптов (для воспроизводимости)
-- ----------------------------------------------------------------------------
CREATE TABLE prompt_versions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_name          TEXT NOT NULL,                   -- 'twin_ye'|'longread_writer'|...
  version              TEXT NOT NULL,                   -- 'v1','v2'
  body                 TEXT NOT NULL,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (prompt_name, version)
);

-- ----------------------------------------------------------------------------
-- 3) knowledge_base — wiki + /knowledge/, RAG-источник
-- ----------------------------------------------------------------------------
CREATE TABLE knowledge_base (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source               TEXT NOT NULL,                   -- 'wiki'|'github_knowledge'
  path                 TEXT NOT NULL,
  title                TEXT,
  content              TEXT NOT NULL,
  embedding            vector(1536),
  meta                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  hash                 TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, path)
);
CREATE INDEX kb_emb_idx     ON knowledge_base USING ivfflat (embedding vector_cosine_ops) WITH (lists = 64);
CREATE INDEX kb_path_trgm   ON knowledge_base USING gin (path gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- 4) bonus_library — готовые лонгриды-PDF
--    (объявлена раньше library_plan/ideas, чтобы FK создавались сразу)
-- ----------------------------------------------------------------------------
CREATE TABLE bonus_library (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                TEXT NOT NULL,
  pain_tag             TEXT NOT NULL,
  outline              JSONB NOT NULL,
  body_md              TEXT NOT NULL,
  pdf_url              TEXT NOT NULL,
  pdf_gdrive_id        TEXT NOT NULL,
  cover_image_url      TEXT,
  word_count           INTEGER NOT NULL,
  embedding            vector(1536),
  status               TEXT NOT NULL DEFAULT 'live'
                       CHECK (status IN ('live','deprecated','archived')),
  origin               TEXT NOT NULL DEFAULT 'audience_brain'
                       CHECK (origin IN ('audience_brain','strategy_c')),
  source_idea_id       UUID,                            -- FK навешиваем после ideas
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ                      -- soft delete only
);
CREATE INDEX bl_emb_idx       ON bonus_library USING ivfflat (embedding vector_cosine_ops) WITH (lists = 32);
CREATE INDEX bl_status_idx    ON bonus_library (status) WHERE deleted_at IS NULL;
CREATE INDEX bl_pain_idx      ON bonus_library (pain_tag) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 5) library_plan — план лонгридов от AUDIENCE BRAIN
-- ----------------------------------------------------------------------------
CREATE TABLE library_plan (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                TEXT NOT NULL,
  pain_tag             TEXT NOT NULL,
  outline              JSONB NOT NULL,
  rationale            TEXT,
  priority             INTEGER,                         -- 1..20 для приоритетных, NULL для backlog
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','in_progress','done','skipped')),
  embedding            vector(1536),
  bonus_id             UUID REFERENCES bonus_library(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX lp_emb_idx       ON library_plan USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX lp_priority_idx  ON library_plan (priority NULLS LAST, status);

-- ----------------------------------------------------------------------------
-- 6) references_inbox — банк референсов из Instagram
-- ----------------------------------------------------------------------------
CREATE TABLE references_inbox (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url           TEXT,
  source_type          TEXT NOT NULL
                       CHECK (source_type IN ('reel','carousel','post','video_file')),
  ig_username          TEXT,
  local_path           TEXT,
  duration_sec         INTEGER,
  download_provider    TEXT
                       CHECK (download_provider IS NULL OR download_provider IN ('yt-dlp','rapidapi','manual')),
  download_status      TEXT NOT NULL DEFAULT 'pending'
                       CHECK (download_status IN ('pending','downloaded','failed')),
  transcript           TEXT,
  visual_analysis      JSONB,
  ocr_text             TEXT,
  embedding            vector(1536),
  status               TEXT NOT NULL DEFAULT 'pending_angle'
                       CHECK (status IN ('pending_angle','adapted','skipped')),
  used_in_idea_id      UUID,                            -- FK после ideas
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ                      -- soft delete only
);
CREATE INDEX ri_status_idx    ON references_inbox (status) WHERE deleted_at IS NULL;
CREATE INDEX ri_emb_idx       ON references_inbox USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ri_username_idx  ON references_inbox (ig_username) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 7) ideas — все идеи контента
-- ----------------------------------------------------------------------------
CREATE TABLE ideas (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source               TEXT NOT NULL
                       CHECK (source IN ('voice','text','reference_adapt')),
  reference_id         UUID REFERENCES references_inbox(id),
  raw_transcript       TEXT,
  angle_transcript     TEXT,                            -- обязательно для reference_adapt
  pain_tag             TEXT,
  summary              TEXT,
  status               TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','strategy_chosen','content_ready','approved','published','abandoned')),
  forced_bonus_id      UUID REFERENCES bonus_library(id),
  strategy             TEXT
                       CHECK (strategy IS NULL OR strategy IN ('A','B','C')),
  strategy_reason      TEXT,
  bonus_id             UUID REFERENCES bonus_library(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ideas_ref_consistent CHECK (
    (source = 'reference_adapt' AND reference_id IS NOT NULL AND angle_transcript IS NOT NULL)
    OR (source IN ('voice','text') AND reference_id IS NULL)
  )
);
CREATE INDEX idea_status_idx  ON ideas (status, created_at DESC);
CREATE INDEX idea_source_idx  ON ideas (source, created_at DESC);
CREATE INDEX idea_pain_idx    ON ideas (pain_tag);

-- Поздно навешиваем FK на bonus_library.source_idea_id и references_inbox.used_in_idea_id
ALTER TABLE bonus_library
  ADD CONSTRAINT bonus_library_source_idea_fk
  FOREIGN KEY (source_idea_id) REFERENCES ideas(id) ON DELETE SET NULL;

ALTER TABLE references_inbox
  ADD CONSTRAINT references_inbox_used_in_idea_fk
  FOREIGN KEY (used_in_idea_id) REFERENCES ideas(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- 8) content_packages — рилс/пост/карусель × голос
-- ----------------------------------------------------------------------------
CREATE TABLE content_packages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id              UUID NOT NULL REFERENCES ideas(id),
  voice_code           TEXT NOT NULL REFERENCES voices(code),
  reel_caption         TEXT NOT NULL,
  tg_post              TEXT NOT NULL,
  carousel_slides      JSONB NOT NULL,
  assets               JSONB,
  validator_report     JSONB,
  approval_status      TEXT NOT NULL DEFAULT 'pending'
                       CHECK (approval_status IN ('pending','approved','rejected')),
  published_at         TIMESTAMPTZ,
  ig_media_id          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX cp_idea_idx      ON content_packages (idea_id);
CREATE INDEX cp_published_idx ON content_packages (published_at DESC) WHERE published_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 9) funnels — воронки в ChatPlace
-- ----------------------------------------------------------------------------
CREATE TABLE funnels (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id                  UUID NOT NULL REFERENCES ideas(id),
  code_word                TEXT NOT NULL UNIQUE,
  strategy                 TEXT NOT NULL CHECK (strategy IN ('A','B','C')),
  bonus_id                 UUID REFERENCES bonus_library(id),
  chatplace_automation_id  TEXT,
  tg_warmup_chain          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','live','paused','archived')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fn_idea_idx      ON funnels (idea_id);
CREATE INDEX fn_status_idx    ON funnels (status);

-- ----------------------------------------------------------------------------
-- 10) getcourse_offers — связки с офферами GC, UTM
-- ----------------------------------------------------------------------------
CREATE TABLE getcourse_offers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  funnel_id            UUID NOT NULL REFERENCES funnels(id),
  gc_offer_id          TEXT NOT NULL,
  gc_url               TEXT NOT NULL,
  utm_source           TEXT NOT NULL DEFAULT 'club_funnel',
  utm_campaign         TEXT NOT NULL,
  price_kopecks        BIGINT NOT NULL DEFAULT 500000   -- 5000.00 ₽
                       CHECK (price_kopecks > 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX gco_funnel_idx   ON getcourse_offers (funnel_id);
CREATE INDEX gco_utm_idx      ON getcourse_offers (utm_campaign);

-- ----------------------------------------------------------------------------
-- 11) subscribers — лиды и клиенты (ПД)
-- ----------------------------------------------------------------------------
CREATE TABLE subscribers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_username          TEXT,
  tg_user_id           BIGINT,
  email                TEXT,
  phone                TEXT,                            -- E.164
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status               TEXT NOT NULL DEFAULT 'lead'
                       CHECK (status IN ('lead','warming','cold_lead','paid','churned')),
  primary_pain         TEXT,
  pd_consent_at        TIMESTAMPTZ,
  pd_consent_text      TEXT,
  notes                TEXT,
  deleted_at           TIMESTAMPTZ                      -- soft delete (152-ФЗ право на забвение)
);
CREATE UNIQUE INDEX sub_ig_uniq    ON subscribers (ig_username) WHERE ig_username IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX sub_tg_uniq    ON subscribers (tg_user_id) WHERE tg_user_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX sub_email_uniq ON subscribers (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX sub_status_idx        ON subscribers (status) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 12) funnel_events — все события воронок (event sourcing)
-- ----------------------------------------------------------------------------
CREATE TABLE funnel_events (
  id                   BIGSERIAL PRIMARY KEY,
  funnel_id            UUID REFERENCES funnels(id),
  subscriber_id        UUID REFERENCES subscribers(id),
  code_word            TEXT,
  event_type           TEXT NOT NULL,
  source               TEXT NOT NULL
                       CHECK (source IN ('chatplace','instagram','getcourse','tg_bot','cron_pull')),
  payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at          TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key      TEXT
);
CREATE UNIQUE INDEX fe_idemp_idx     ON funnel_events (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX fe_codeword_idx         ON funnel_events (code_word, occurred_at DESC);
CREATE INDEX fe_subscriber_idx       ON funnel_events (subscriber_id, occurred_at DESC);
CREATE INDEX fe_event_type_idx       ON funnel_events (event_type, occurred_at DESC);
CREATE INDEX fe_funnel_idx           ON funnel_events (funnel_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- 13) payments — оплаты (от GC через webhook + reconcile pull)
-- ----------------------------------------------------------------------------
CREATE TABLE payments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id            UUID NOT NULL REFERENCES subscribers(id),
  funnel_id                UUID REFERENCES funnels(id),
  gc_order_id              TEXT NOT NULL UNIQUE,
  amount_kopecks           BIGINT NOT NULL CHECK (amount_kopecks > 0),
  currency                 TEXT NOT NULL DEFAULT 'RUB',
  utm_source               TEXT,
  utm_campaign             TEXT,
  paid_at                  TIMESTAMPTZ NOT NULL,
  webhook_received_at      TIMESTAMPTZ,
  reconciled_via           TEXT NOT NULL CHECK (reconciled_via IN ('webhook','pull')),
  raw_payload              JSONB NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX p_funnel_idx     ON payments (funnel_id);
CREATE INDEX p_paid_at_idx    ON payments (paid_at DESC);
CREATE INDEX p_utm_idx        ON payments (utm_campaign);

-- ----------------------------------------------------------------------------
-- 14) winning_patterns — топ-10% по CR (для retrain)
-- ----------------------------------------------------------------------------
CREATE TABLE winning_patterns (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_package_id       UUID NOT NULL REFERENCES content_packages(id),
  idea_id                  UUID NOT NULL REFERENCES ideas(id),
  source_type              TEXT NOT NULL CHECK (source_type IN ('voice','reference_adapt')),
  pain_tag                 TEXT NOT NULL,
  cr_to_paid               NUMERIC(6,4) NOT NULL,
  total_leads              INTEGER NOT NULL CHECK (total_leads >= 0),
  paid_count               INTEGER NOT NULL CHECK (paid_count >= 0),
  voice_code               TEXT NOT NULL REFERENCES voices(code),
  hooks_extracted          JSONB,
  embedding                vector(1536),
  promoted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX wp_pain_idx      ON winning_patterns (pain_tag, cr_to_paid DESC);
CREATE INDEX wp_src_idx       ON winning_patterns (source_type, cr_to_paid DESC);
CREATE INDEX wp_emb_idx       ON winning_patterns USING ivfflat (embedding vector_cosine_ops);

-- ----------------------------------------------------------------------------
-- 15) bonus_alerts — алерты по выгоревшим лонгридам
-- ----------------------------------------------------------------------------
CREATE TABLE bonus_alerts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bonus_id                 UUID NOT NULL REFERENCES bonus_library(id),
  alert_type               TEXT NOT NULL CHECK (alert_type IN ('cr_drop','staleness','duplicate_topic')),
  cr_peak                  NUMERIC(6,4),
  cr_current               NUMERIC(6,4),
  drop_pct                 NUMERIC(5,2),
  recommendation           TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','acknowledged','dismissed','fixed')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at          TIMESTAMPTZ,
  resolved_at              TIMESTAMPTZ
);
CREATE INDEX ba_status_idx    ON bonus_alerts (status, created_at DESC);
CREATE INDEX ba_bonus_idx     ON bonus_alerts (bonus_id);

-- ----------------------------------------------------------------------------
-- 16) approval_log — история согласований (вход для retrain)
-- ----------------------------------------------------------------------------
CREATE TABLE approval_log (
  id                       BIGSERIAL PRIMARY KEY,
  idea_id                  UUID NOT NULL REFERENCES ideas(id),
  artifact_type            TEXT NOT NULL,
  voice_code               TEXT REFERENCES voices(code),
  action                   TEXT NOT NULL
                           CHECK (action IN ('approved','rejected','commented','cancelled')),
  comment                  TEXT,
  attempt_no               INTEGER NOT NULL DEFAULT 1,
  acted_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX al_idea_idx      ON approval_log (idea_id, acted_at DESC);
CREATE INDEX al_action_idx    ON approval_log (action, acted_at DESC);

-- ----------------------------------------------------------------------------
-- 17) weekly_reports
-- ----------------------------------------------------------------------------
CREATE TABLE weekly_reports (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start               DATE NOT NULL,
  week_end                 DATE NOT NULL,
  report_md                TEXT NOT NULL,
  metrics_json             JSONB NOT NULL,
  recommendations          JSONB NOT NULL,
  generated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX wr_week_uniq ON weekly_reports (week_start);

-- ----------------------------------------------------------------------------
-- 18) audit_log — что менялось в чувствительных таблицах
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id                       BIGSERIAL PRIMARY KEY,
  actor                    TEXT NOT NULL,
  action                   TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  entity                   TEXT NOT NULL,
  entity_id                TEXT NOT NULL,
  before                   JSONB,
  after                    JSONB,
  at                       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id, at DESC);

-- ----------------------------------------------------------------------------
-- 19) pending_jobs — fallback очередь при недоступности Redis
-- ----------------------------------------------------------------------------
CREATE TABLE pending_jobs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name               TEXT NOT NULL,
  payload                  JSONB NOT NULL,
  attempts                 INTEGER NOT NULL DEFAULT 0,
  max_attempts             INTEGER NOT NULL DEFAULT 5,
  next_run_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                   TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','done','failed')),
  last_error               TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX pj_pickup_idx ON pending_jobs (queue_name, next_run_at) WHERE status = 'queued';

-- ============================================================================
-- AUDIT TRIGGERS — на subscribers, bonus_library, references_inbox, payments, voices
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_audit_trigger() RETURNS trigger AS $$
DECLARE
  actor_name TEXT := COALESCE(current_setting('app.actor', true), session_user);
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor, action, entity, entity_id, after)
    VALUES (actor_name, TG_OP, TG_TABLE_NAME, NEW.id::text, to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
    VALUES (actor_name, TG_OP, TG_TABLE_NAME, NEW.id::text, to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (actor, action, entity, entity_id, before)
    VALUES (actor_name, TG_OP, TG_TABLE_NAME, OLD.id::text, to_jsonb(OLD));
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_subscribers       AFTER INSERT OR UPDATE OR DELETE ON subscribers
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();
CREATE TRIGGER trg_audit_bonus_library     AFTER INSERT OR UPDATE OR DELETE ON bonus_library
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();
CREATE TRIGGER trg_audit_references_inbox  AFTER INSERT OR UPDATE OR DELETE ON references_inbox
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();
CREATE TRIGGER trg_audit_payments          AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();
CREATE TRIGGER trg_audit_voices            AFTER INSERT OR UPDATE OR DELETE ON voices
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();

-- ============================================================================
-- updated_at автообновление
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'voices','knowledge_base','bonus_library','library_plan','references_inbox',
      'ideas','content_packages','funnels'
    ])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_updated_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();',
      t, t
    );
  END LOOP;
END $$;

-- ============================================================================
-- ROLES & RLS — soft-delete защита
-- Создаём роли (если ещё нет). Пароли задаются ОТДЕЛЬНОЙ командой
-- (хранятся в .env). НЕ закладывайте пароли в миграции.
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_dba') THEN
    CREATE ROLE admin_dba LOGIN SUPERUSER;
  END IF;
END $$;

-- Базовые права для приложения
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_runtime;

-- Отзываем DELETE на чувствительные таблицы у app_runtime
REVOKE DELETE ON subscribers      FROM app_runtime;
REVOKE DELETE ON bonus_library    FROM app_runtime;
REVOKE DELETE ON references_inbox FROM app_runtime;

-- Включаем RLS
ALTER TABLE subscribers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bonus_library    ENABLE ROW LEVEL SECURITY;
ALTER TABLE references_inbox ENABLE ROW LEVEL SECURITY;

-- Политика: app_runtime может SELECT/INSERT/UPDATE; DELETE недоступен на уровне GRANT
CREATE POLICY app_full_select_subscribers      ON subscribers      FOR SELECT TO app_runtime USING (TRUE);
CREATE POLICY app_full_modify_subscribers_ins  ON subscribers      FOR INSERT TO app_runtime WITH CHECK (TRUE);
CREATE POLICY app_full_modify_subscribers_upd  ON subscribers      FOR UPDATE TO app_runtime USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY app_full_select_bonus_library      ON bonus_library     FOR SELECT TO app_runtime USING (TRUE);
CREATE POLICY app_full_modify_bonus_library_ins  ON bonus_library     FOR INSERT TO app_runtime WITH CHECK (TRUE);
CREATE POLICY app_full_modify_bonus_library_upd  ON bonus_library     FOR UPDATE TO app_runtime USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY app_full_select_references_inbox      ON references_inbox  FOR SELECT TO app_runtime USING (TRUE);
CREATE POLICY app_full_modify_references_inbox_ins  ON references_inbox  FOR INSERT TO app_runtime WITH CHECK (TRUE);
CREATE POLICY app_full_modify_references_inbox_upd  ON references_inbox  FOR UPDATE TO app_runtime USING (TRUE) WITH CHECK (TRUE);

-- ============================================================================
-- Полезные представления
-- ============================================================================

-- Сквозная воронка по кодовому слову
CREATE OR REPLACE VIEW v_funnel_metrics AS
SELECT
  f.id                AS funnel_id,
  f.code_word,
  f.strategy,
  f.bonus_id,
  COUNT(*) FILTER (WHERE fe.event_type = 'ig_comment')             AS ig_comments,
  COUNT(*) FILTER (WHERE fe.event_type = 'direct_received')        AS directs,
  COUNT(*) FILTER (WHERE fe.event_type = 'subscribed_check_pass')  AS sub_passed,
  COUNT(*) FILTER (WHERE fe.event_type = 'pdf_delivered')          AS pdfs_delivered,
  COUNT(*) FILTER (WHERE fe.event_type = 'tg_joined')              AS tg_joined,
  COUNT(*) FILTER (WHERE fe.event_type = 'cta_clicked')            AS cta_clicks,
  COUNT(p.id)                                                      AS payments_count,
  COALESCE(SUM(p.amount_kopecks), 0)                               AS revenue_kopecks
FROM funnels f
LEFT JOIN funnel_events fe ON fe.funnel_id = f.id
LEFT JOIN payments p ON p.funnel_id = f.id
GROUP BY f.id, f.code_word, f.strategy, f.bonus_id;

-- CR на лонгрид (для bonus_alerts детектора)
CREATE OR REPLACE VIEW v_bonus_cr_rolling AS
SELECT
  bl.id AS bonus_id,
  bl.title,
  bl.pain_tag,
  COUNT(p.id) FILTER (WHERE p.paid_at >= NOW() - INTERVAL '30 days')           AS paid_30d,
  COUNT(fe.id) FILTER (
    WHERE fe.event_type = 'pdf_delivered' AND fe.occurred_at >= NOW() - INTERVAL '30 days'
  )                                                                            AS leads_30d,
  CASE
    WHEN COUNT(fe.id) FILTER (
      WHERE fe.event_type = 'pdf_delivered' AND fe.occurred_at >= NOW() - INTERVAL '30 days'
    ) > 0
    THEN (COUNT(p.id) FILTER (WHERE p.paid_at >= NOW() - INTERVAL '30 days'))::numeric
       / (COUNT(fe.id) FILTER (
           WHERE fe.event_type = 'pdf_delivered' AND fe.occurred_at >= NOW() - INTERVAL '30 days'
         ))::numeric
    ELSE 0
  END AS cr_30d,
  COUNT(p.id)                                                                  AS paid_total,
  COUNT(fe.id) FILTER (WHERE fe.event_type = 'pdf_delivered')                  AS leads_total,
  CASE
    WHEN COUNT(fe.id) FILTER (WHERE fe.event_type = 'pdf_delivered') > 0
    THEN COUNT(p.id)::numeric
       / COUNT(fe.id) FILTER (WHERE fe.event_type = 'pdf_delivered')::numeric
    ELSE 0
  END AS cr_alltime
FROM bonus_library bl
LEFT JOIN funnels f       ON f.bonus_id = bl.id
LEFT JOIN funnel_events fe ON fe.funnel_id = f.id
LEFT JOIN payments p      ON p.funnel_id = f.id
WHERE bl.deleted_at IS NULL
GROUP BY bl.id, bl.title, bl.pain_tag;

-- Сравнение CR по стратегиям A/B/C за последние 30 дней (для weekly report)
CREATE OR REPLACE VIEW v_strategy_cr_30d AS
SELECT
  f.strategy,
  COUNT(DISTINCT f.id)                                            AS funnels_count,
  COUNT(fe.id) FILTER (
    WHERE fe.event_type = 'direct_received'
      AND fe.occurred_at >= NOW() - INTERVAL '30 days'
  )                                                               AS leads_30d,
  COUNT(p.id) FILTER (WHERE p.paid_at >= NOW() - INTERVAL '30 days') AS paid_30d,
  CASE
    WHEN COUNT(fe.id) FILTER (
      WHERE fe.event_type = 'direct_received'
        AND fe.occurred_at >= NOW() - INTERVAL '30 days'
    ) > 0
    THEN (COUNT(p.id) FILTER (WHERE p.paid_at >= NOW() - INTERVAL '30 days'))::numeric
       / (COUNT(fe.id) FILTER (
           WHERE fe.event_type = 'direct_received'
             AND fe.occurred_at >= NOW() - INTERVAL '30 days'
         ))::numeric
    ELSE 0
  END AS cr_to_paid
FROM funnels f
LEFT JOIN funnel_events fe ON fe.funnel_id = f.id
LEFT JOIN payments p       ON p.funnel_id = f.id
GROUP BY f.strategy;

-- Сравнение CR по источнику идей: voice vs reference_adapt (за 30 дней)
CREATE OR REPLACE VIEW v_source_cr_30d AS
SELECT
  i.source,
  COUNT(DISTINCT f.id)                                            AS funnels_count,
  COUNT(fe.id) FILTER (
    WHERE fe.event_type = 'direct_received'
      AND fe.occurred_at >= NOW() - INTERVAL '30 days'
  )                                                               AS leads_30d,
  COUNT(p.id) FILTER (WHERE p.paid_at >= NOW() - INTERVAL '30 days') AS paid_30d,
  CASE
    WHEN COUNT(fe.id) FILTER (
      WHERE fe.event_type = 'direct_received'
        AND fe.occurred_at >= NOW() - INTERVAL '30 days'
    ) > 0
    THEN (COUNT(p.id) FILTER (WHERE p.paid_at >= NOW() - INTERVAL '30 days'))::numeric
       / (COUNT(fe.id) FILTER (
           WHERE fe.event_type = 'direct_received'
             AND fe.occurred_at >= NOW() - INTERVAL '30 days'
         ))::numeric
    ELSE 0
  END AS cr_to_paid
FROM ideas i
JOIN funnels f             ON f.idea_id = i.id
LEFT JOIN funnel_events fe ON fe.funnel_id = f.id
LEFT JOIN payments p       ON p.funnel_id = f.id
GROUP BY i.source;

-- Каталог референсов с инфой об использовании (для команды /references)
CREATE OR REPLACE VIEW v_references_catalog AS
SELECT
  ri.id,
  ri.source_url,
  ri.source_type,
  ri.ig_username,
  ri.status,
  ri.download_status,
  ri.created_at,
  i.id              AS idea_id,
  i.summary         AS idea_summary,
  f.code_word,
  f.strategy,
  COUNT(p.id)       AS payments_count,
  COALESCE(SUM(p.amount_kopecks), 0) AS revenue_kopecks
FROM references_inbox ri
LEFT JOIN ideas i      ON i.reference_id = ri.id
LEFT JOIN funnels f    ON f.idea_id = i.id
LEFT JOIN payments p   ON p.funnel_id = f.id
WHERE ri.deleted_at IS NULL
GROUP BY ri.id, i.id, f.code_word, f.strategy;

-- ============================================================================
-- Schema migrations bookkeeping
-- ============================================================================
CREATE TABLE IF NOT EXISTS _schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO _schema_migrations (version) VALUES ('001_initial')
  ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- КОНЕЦ 001_initial.sql
-- ============================================================================
