// funnel-activator — активирует воронку при approve content_package (AC-27).
//
// Что делает на одобрении:
//   1. Генерит уникальное code_word.
//   2. INSERT в funnels (idea_id, code_word, strategy, bonus_id, status='live').
//   3. Создаёт ChatPlace scenario:
//        triggers: получение code_word в Direct
//        steps:    A/C → send PDF лонгрида; B → welcome + ссылка на TG-бот warmup
//   4. Записывает chatplace_automation_id обратно в funnels.
//   5. funnel_events.event_type='longread_offered' (или 'club_offered' для B).
//
// Best-effort: если ChatPlace недоступен — funnel запись остаётся, но без
// chatplace_automation_id. Можно ретраить отдельно.

import type { Pool } from 'pg';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import { createChatPlaceClient, type ChatPlaceScenarioDefinition } from '../integrations/chatplace.js';
import { generateUniqueCodeWord } from './code-word-generator.js';
import { trackEvent } from './funnel.js';

export interface ActivateFunnelInput {
  ideaId: string;
  contentPackageId: string;
}

export interface ActivateFunnelResult {
  funnelId: string;
  codeWord: string;
  chatplaceAutomationId: string | null;
  status: 'live' | 'draft';
}

/**
 * Активирует воронку после approve. Идемпотентность: если funnel для этой
 * idea уже существует (status='live') — возвращает её без повторного создания.
 */
export async function activateFunnelOnApprove(
  pool: Pool,
  input: ActivateFunnelInput,
): Promise<ActivateFunnelResult | null> {
  // 1. Проверка идемпотентности.
  const existing = await pool.query<{
    id: string;
    code_word: string;
    chatplace_automation_id: string | null;
    status: 'draft' | 'live' | 'paused' | 'archived';
  }>(
    `SELECT id, code_word, chatplace_automation_id, status
       FROM funnels WHERE idea_id = $1
       ORDER BY created_at DESC LIMIT 1`,
    [input.ideaId],
  );
  if (existing.rows.length > 0 && existing.rows[0]?.status === 'live') {
    const r = existing.rows[0];
    log.info(
      { ideaId: input.ideaId, funnelId: r.id, codeWord: r.code_word },
      'funnel-activator: already active, skipping',
    );
    return {
      funnelId: r.id,
      codeWord: r.code_word,
      chatplaceAutomationId: r.chatplace_automation_id,
      status: r.status,
    };
  }

  // 2. Достаём idea + bonus + strategy.
  const ideaRes = await pool.query<{
    id: string;
    strategy: 'A' | 'B' | 'C' | null;
    pain_tag: string | null;
    bonus_id: string | null;
    summary: string | null;
  }>(
    `SELECT id, strategy, pain_tag, bonus_id, summary FROM ideas WHERE id = $1`,
    [input.ideaId],
  );
  const idea = ideaRes.rows[0];
  if (!idea) {
    log.warn({ ideaId: input.ideaId }, 'funnel-activator: idea not found');
    return null;
  }
  if (!idea.strategy) {
    log.warn({ ideaId: input.ideaId }, 'funnel-activator: idea.strategy is null, skipping');
    return null;
  }

  // 3. Bonus (для A/C). Для B — null.
  let bonusPdfUrl: string | null = null;
  let bonusTitle: string | null = null;
  if (idea.strategy !== 'B' && idea.bonus_id) {
    const bRes = await pool.query<{ pdf_url: string; title: string }>(
      `SELECT pdf_url, title FROM bonus_library
        WHERE id = $1 AND status = 'live' AND deleted_at IS NULL`,
      [idea.bonus_id],
    );
    if (bRes.rows[0]) {
      bonusPdfUrl = bRes.rows[0].pdf_url;
      bonusTitle = bRes.rows[0].title;
    }
  }

  // 4. Генерим code_word.
  const codeWord = await generateUniqueCodeWord(
    pool,
    idea.pain_tag ? { painSeed: idea.pain_tag } : {},
  );
  log.info({ ideaId: input.ideaId, codeWord, strategy: idea.strategy }, 'funnel-activator: code_word');

  // 5. INSERT в funnels (status='live' даже если ChatPlace упадёт — retry через cron).
  const funnelIns = await pool.query<{ id: string }>(
    `INSERT INTO funnels (idea_id, code_word, strategy, bonus_id, status)
     VALUES ($1, $2, $3, $4, 'live')
     RETURNING id`,
    [input.ideaId, codeWord, idea.strategy, idea.bonus_id],
  );
  const funnelId = funnelIns.rows[0]!.id;

  // 6. ChatPlace scenario (best-effort). DEV_DRY_RUN_CHATPLACE=true в env → не реальный вызов.
  let chatplaceAutomationId: string | null = null;
  try {
    const cp = createChatPlaceClient();
    const tgBotLink = `https://t.me/${(config.TELEGRAM_BOT_USERNAME ?? 'Realizacia_marketing_bot').replace(/^@/, '')}?start=${codeWord}`;
    const def: ChatPlaceScenarioDefinition = {
      code: codeWord,
      name: `Воронка ${codeWord} · pain=${idea.pain_tag ?? '—'} · strategy=${idea.strategy}`,
      triggers: [{ type: 'instagram_dm_keyword', keyword: codeWord }],
      steps:
        idea.strategy === 'B'
          ? [
              {
                type: 'send_message',
                text:
                  `Привет! Спасибо что написал «${codeWord}». ` +
                  `Я Юрий Еремин. Все материалы и ответы — в моём Telegram-канале клуба «Реализация». ` +
                  `Заходи: ${tgBotLink}`,
              },
              { type: 'tag', tags: [`club_funnel_${codeWord}`] },
            ]
          : [
              ...(bonusPdfUrl
                ? [
                    {
                      type: 'send_file',
                      file_url: bonusPdfUrl,
                      caption: `Вот лонгрид «${bonusTitle ?? 'забери и почитай'}». Запасайся чаем — 1500–2500 слов.`,
                    },
                  ]
                : []),
              {
                type: 'send_message',
                text:
                  `Когда прочитаешь, заходи в мой TG-канал клуба: ${tgBotLink}\n` +
                  `Там продолжение и кнопка «Вступить в клуб». ❤️‍🔥`,
              },
              { type: 'tag', tags: [`club_funnel_${codeWord}`] },
            ],
      enabled: true,
    };
    const scen = await cp.createScenario(def);
    chatplaceAutomationId = scen.id;
    await pool.query(
      `UPDATE funnels SET chatplace_automation_id = $2, updated_at = NOW() WHERE id = $1`,
      [funnelId, chatplaceAutomationId],
    );
    log.info(
      { funnelId, codeWord, chatplaceAutomationId },
      'funnel-activator: ChatPlace scenario created',
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message, funnelId, codeWord },
      'funnel-activator: ChatPlace createScenario failed (funnel live, automation pending retry)',
    );
  }

  // 7. funnel_events: longread_offered (A/C) или club_offered (B).
  try {
    await trackEvent(
      {
        subscriberId: null,
        funnelId,
        codeWord,
        eventCode: idea.strategy === 'B' ? 'club_offered' : 'longread_offered',
        source: 'tg_bot',
        idempotencyKey: `funnel-active:${funnelId}`,
        payload: { strategy: idea.strategy, bonusId: idea.bonus_id },
      },
      { pool },
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'funnel-activator: trackEvent failed (non-fatal)');
  }

  return {
    funnelId,
    codeWord,
    chatplaceAutomationId,
    status: 'live',
  };
}
