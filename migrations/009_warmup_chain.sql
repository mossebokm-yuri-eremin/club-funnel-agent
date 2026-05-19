-- ============================================================================
-- migrations/009_warmup_chain.sql
-- Прогревочная цепочка в TG-боте (SPEC AC-28 + AC-30).
--
-- Логика:
--   1. Подписчик жмёт «забери лонгрид» в IG Direct → ChatPlace шлёт ему ссылку
--      https://t.me/<bot>?start=<code_word>.
--   2. Подписчик открывает TG бот → /start <code_word> handler:
--        - находит funnel по code_word
--        - upsert subscriber (status='warming')
--        - INSERT 3-5 рядов в warmup_messages с интервалом +1 день
--        - первое сообщение шлёт сразу
--   3. warmup-sender-worker (cron */5 минут) шлёт scheduled_at <= NOW().
--   4. AC-30: 7 дней без оплаты → длинный прогрев 1/нед × 8 нед → status='cold_lead'.
-- ============================================================================

CREATE TABLE IF NOT EXISTS warmup_messages (
  id                  BIGSERIAL    PRIMARY KEY,
  subscriber_id       UUID         NOT NULL REFERENCES subscribers(id),
  funnel_id           UUID         NOT NULL REFERENCES funnels(id),
  step                INTEGER      NOT NULL,                         -- 1..N
  chain_type          TEXT         NOT NULL DEFAULT 'short'
                                   CHECK (chain_type IN ('short', 'long')),
                                   -- short: 3-5 сообщений × 1 день (AC-28)
                                   -- long:  8 сообщений × 1 неделя (AC-30)
  body_md             TEXT         NOT NULL,
  scheduled_at        TIMESTAMPTZ  NOT NULL,
  sent_at             TIMESTAMPTZ,
  status              TEXT         NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','sent','failed','skipped','cancelled')),
  tg_message_id       BIGINT,
  fail_reason         TEXT,
  cta_url             TEXT,                                          -- UTM-метка ведёт на GC оффер
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (subscriber_id, funnel_id, step, chain_type)
);

CREATE INDEX IF NOT EXISTS wm_pending_idx
  ON warmup_messages (status, scheduled_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS wm_sub_idx ON warmup_messages (subscriber_id);
CREATE INDEX IF NOT EXISTS wm_funnel_idx ON warmup_messages (funnel_id);

GRANT SELECT, INSERT, UPDATE ON warmup_messages TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE warmup_messages_id_seq TO app_runtime;
